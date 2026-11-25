import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Limiter, QuotaError, configFromEnv } from '../src/limits.ts'
import { gatewayLlm, modelChain } from '../src/connectors.ts'
import { nameMatch, pickPhoto } from '../src/photos.ts'

const cfg = { llmCallsPerDay: 10, plansPerDay: 3, chatsPerDay: 5, ipPlansPerHour: 1, ipPlansPerDay: 2, ipChatsPerHour: 2, ipChatsPerDay: 3 }

test('per-visitor hourly and daily limits, global limits, and the AI allowance', () => {
  let now = new Date('2030-01-01T10:00:00Z')
  const l = new Limiter(cfg, undefined, () => now)
  l.take('plan', 'a')
  assert.throws(() => l.take('plan', 'a'), (e: QuotaError) => e instanceof QuotaError && /per hour/.test(e.message) && e.retryAfterSec <= 3600)
  now = new Date('2030-01-01T11:05:00Z')
  l.take('plan', 'a')
  now = new Date('2030-01-01T12:05:00Z')
  assert.throws(() => l.take('plan', 'a'), /limit per visitor/)
  l.take('plan', 'b')
  assert.throws(() => l.take('plan', 'c'), /3 trips a day/)
  for (let i = 0; i < 10; i++) l.llmCall()
  assert.throws(() => l.llmCall(), /allowance/)
  assert.throws(() => l.take('chat', 'z'), /allowance/)
  now = new Date('2030-01-02T00:00:01Z')
  l.take('plan', 'a')
  assert.equal(l.status('a').aiCallsLeft, 10)
})

test('counters survive a restart (saved on disk)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lim-'))
  const file = join(dir, 'limits.json')
  const now = () => new Date('2030-01-01T10:00:00Z')
  const a = new Limiter(cfg, file, now)
  a.take('chat', 'x')
  a.llmCall()
  const b = new Limiter(cfg, file, now)
  assert.equal(b.status().aiCallsLeft, 9)
  assert.equal(b.status('x').chatsLeft, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('free tier only: paid models are dropped unless explicitly allowed', () => {
  assert.ok(modelChain({}).every((m) => m.endsWith(':free')))
  assert.deepEqual(modelChain({ HIVE_MODELS: 'openai/gpt-4.1-mini, a/b:free' }), ['a/b:free'])
  assert.deepEqual(modelChain({ HIVE_MODELS: 'openai/gpt-4.1-mini', HIVE_ALLOW_PAID: '1' }), ['openai/gpt-4.1-mini'])
  assert.equal(configFromEnv({}).llmCallsPerDay, 45)
})

test('model chain falls through rate-limited free models and counts every attempt', async () => {
  const tried: string[] = []
  const counted: string[] = []
  const f = (async (_u: string, init: RequestInit) => {
    const m = JSON.parse(String(init.body)).model
    tried.push(m)
    if (m === 'a:free') return new Response('{"error":"rate limited"}', { status: 429 })
    return new Response(JSON.stringify({ choices: [{ message: { content: `hi from ${m}` } }] }))
  }) as unknown as typeof fetch
  const llm = gatewayLlm('https://gw/v1', ['a:free', 'b:free'], f, 100, (m) => counted.push(m))
  assert.equal((await llm([{ role: 'user', content: 'x' }], [])).content, 'hi from b:free')
  assert.deepEqual(tried, ['a:free', 'b:free'])
  assert.deepEqual(counted, ['a:free', 'b:free'])
  // sticks with the model that answered
  await llm([{ role: 'user', content: 'y' }], [])
  assert.equal(tried.at(-1), 'b:free')
})

test('photos are only used when they really show the place', () => {
  assert.ok(nameMatch('Castelo de São Jorge', 'São Jorge Castle') >= 0.6)
  assert.equal(nameMatch('Taberna da Rua das Flores', 'Alfama'), 0)
  const pages = [
    { title: 'São Jorge Castle', lat: 38.7139, lng: -9.1335, thumb: 'castle.jpg' },
    { title: 'Alfama', lat: 38.7118, lng: -9.1300, thumb: 'alfama.jpg' },
  ]
  assert.equal(pickPhoto({ name: 'Castelo de São Jorge', lat: 38.7138, lng: -9.1336, kind: 'attraction' }, pages)?.url, 'castle.jpg')
  assert.equal(pickPhoto({ name: 'Taberna da Rua das Flores', lat: 38.7118, lng: -9.13, kind: 'restaurant' }, pages), null, 'no wrong photo for a restaurant')
})

test('API request bucket refills over time', async () => {
  const { allowRequest } = await import('../src/server.ts')
  const t0 = 1_000_000
  let ok = 0
  for (let i = 0; i < 100; i++) if (allowRequest('bucket-ip', t0, 90)) ok++
  assert.equal(ok, 90)
  assert.equal(allowRequest('bucket-ip', t0 + 2_000, 90), true, '2s later: 3 tokens back')
})

test('place search falls back to Nominatim when Photon is unreachable, then skips Photon', async () => {
  const { findPlaces, photonAvailable } = await import('../src/world.ts')
  const hosts: string[] = []
  const f = (async (u: string) => {
    const url = new URL(String(u))
    hosts.push(url.host)
    if (url.host === 'photon.komoot.io') throw new TypeError('fetch failed')
    if (url.host === 'nominatim.openstreetmap.org') return new Response(JSON.stringify([{ name: 'Kyoto National Museum', display_name: 'Kyoto National Museum, Higashiyama, Kyoto', lat: '34.99', lon: '135.773' }]))
    return new Response('[]', { status: 500 })
  }) as typeof fetch
  const got = await findPlaces(35.0, 135.77, 'museum', 3000, f)
  assert.deepEqual(got.map((p) => p.name), ['Kyoto National Museum'])
  assert.equal(photonAvailable(), false)
  hosts.length = 0
  await findPlaces(35.0, 135.77, 'museum', 3000, f)
  assert.ok(!hosts.includes('photon.komoot.io'), 'breaker open: Photon skipped')
})

test('client IP counts from the right of X-Forwarded-For, so spoofed entries are ignored', async () => {
  const { clientIp } = await import('../src/server.ts')
  const req = (xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '::1' } }) as never
  assert.equal(clientIp(req('64.136.145.1, 169.155.48.226, 172.16.40.2')), '64.136.145.1')
  assert.equal(clientIp(req('6.6.6.6, 64.136.145.1, 169.155.48.226, 172.16.40.2')), '64.136.145.1', 'client-sent prefix ignored')
  assert.equal(clientIp(req()), '::1')
})
