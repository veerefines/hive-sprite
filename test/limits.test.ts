import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Limiter, QuotaError, configFromEnv } from '../src/limits.ts'
import { gatewayLlm, modelChain } from '../src/connectors.ts'
import { nameMatch, pickPhoto } from '../src/photos.ts'

const cfg = { llmCallsPerDay: 10, plansPerDay: 6, chatsPerDay: 5, ipPlansPerHour: 5, ipPlansPerDay: 5, ipChatsPerHour: 2, ipChatsPerDay: 3 }

test('status explains which plan limits are exhausted and when they reset', () => {
  let now = new Date('2030-01-01T10:30:00Z')
  const l = new Limiter({ ...cfg, ipPlansPerHour: 1, ipPlansPerDay: 2 }, undefined, () => now)

  l.take('plan', 'hourly')
  assert.deepEqual(l.status('hourly').planLimitReasons, [
    { reason: 'visitor-hourly', retryAfterSec: 1800 },
  ])

  now = new Date('2030-01-01T11:00:00Z')
  assert.deepEqual(l.status('hourly').planLimitReasons, [])
  l.take('plan', 'hourly')
  now = new Date('2030-01-01T12:00:00Z')
  assert.deepEqual(l.status('hourly').planLimitReasons, [
    { reason: 'visitor-daily', retryAfterSec: 43200 },
  ])

  const daily = new Limiter({ ...cfg, ipPlansPerHour: 99, ipPlansPerDay: 1 }, undefined, () => now)
  daily.take('plan', 'daily')
  assert.deepEqual(daily.status('daily').planLimitReasons, [
    { reason: 'visitor-daily', retryAfterSec: 43200 },
  ])

  const global = new Limiter({ ...cfg, plansPerDay: 0 }, undefined, () => now)
  assert.deepEqual(global.status('daily').planLimitReasons, [
    { reason: 'global-daily', retryAfterSec: 43200 },
  ])

  const noAi = new Limiter({ ...cfg, llmCallsPerDay: 5 }, undefined, () => now)
  assert.deepEqual(noAi.status('daily').planLimitReasons, [
    { reason: 'ai-daily', retryAfterSec: 43200 },
  ])

  const tied = new Limiter({ ...cfg, llmCallsPerDay: 11, ipPlansPerHour: 1, ipPlansPerDay: 1 }, undefined, () => now)
  tied.take('plan', 'tied')
  for (let i = 0; i < 6; i++) tied.llmCall()
  assert.deepEqual(tied.status('tied').planLimitReasons, [
    { reason: 'visitor-daily', retryAfterSec: 43200 },
    { reason: 'visitor-hourly', retryAfterSec: 3600 },
    { reason: 'ai-daily', retryAfterSec: 43200 },
  ])

  let clockReads = 0
  const snapshot = new Limiter(cfg, undefined, () => {
    clockReads++
    return new Date(clockReads === 1 ? '2030-01-01T23:59:59Z' : '2030-01-02T00:00:01Z')
  })
  assert.deepEqual(snapshot.status('snapshot').planLimitReasons, [])
  assert.equal(clockReads, 1, 'status should use one clock snapshot')
})

test('per-visitor hourly and daily limits, global limits, and the AI allowance', () => {
  let now = new Date('2030-01-01T10:00:00Z')
  const l = new Limiter(cfg, undefined, () => now)
  for (let i = 0; i < 5; i++) l.take('plan', 'a')
  assert.equal(l.status('a').plansLeft, 0, 'five plans exhaust hourly and daily per-visitor caps')
  assert.deepEqual(l.status('a').planLimitReasons.map((x) => x.reason), ['visitor-daily', 'visitor-hourly'])
  assert.throws(() => l.take('plan', 'a'), (e: QuotaError) => e instanceof QuotaError && /trips today/.test(e.message) && e.retryAfterSec <= 86_400)
  assert.equal(l.status('b').plansLeft, 1, 'global cap leaves one plan for another visitor')
  l.take('plan', 'b')
  assert.throws(() => l.take('plan', 'c'), /6 trips a day/)
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
  const kyoto = [{ title: 'Kyoto Imperial Palace', lat: 35.0254, lng: 135.7621, thumb: 'kip.jpg' }]
  assert.equal(pickPhoto({ name: 'Sento Imperial Palace', lat: 35.0205, lng: 135.7665, kind: 'attraction' }, kyoto), null, 'a neighbouring palace is not this palace')
})

test('hotels and cafes now qualify for landmark matching tier', () => {
  const pages = [
    { title: 'Grand Hotel Europa', lat: 50.0755, lng: 14.4178, thumb: 'hotel.jpg' },
    { title: 'Café Slavia', lat: 50.0808, lng: 14.4132, thumb: 'cafe.jpg' },
  ]
  // Hotel within 60m with good name match gets a photo
  assert.equal(pickPhoto({ name: 'Hotel Europa', lat: 50.0755, lng: 14.4179, kind: 'hotel' }, pages)?.url, 'hotel.jpg')
  // Cafe within 60m with good name match gets a photo
  assert.equal(pickPhoto({ name: 'Slavia Cafe', lat: 50.0808, lng: 14.4133, kind: 'cafe' }, pages)?.url, 'cafe.jpg')
})

test('near-exact name matches are accepted with relaxed threshold', () => {
  assert.ok(nameMatch('Grand Hotel', 'The Grand Hotel') >= 0.8)
  assert.ok(nameMatch('Hotel Europa', 'Grand Hotel Europa') >= 0.8)
  const pages = [{ title: 'The Grand Hotel Vienna', lat: 48.2082, lng: 16.3738, thumb: 'grand.jpg' }]
  // 0.8+ match within 1.5km qualifies under tier-1
  assert.equal(pickPhoto({ name: 'Grand Hotel Vienna', lat: 48.2082, lng: 16.3740, kind: 'hotel' }, pages)?.url, 'grand.jpg')
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
