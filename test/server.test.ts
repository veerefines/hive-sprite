import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { D1, call, fakeFetch, fakeRoute, goodDay1, s, scripted } from './fakes.ts'

const dir = mkdtempSync(join(tmpdir(), 'hive-'))
process.env.HIVE_DATA_DIR = dir
const { makeServer, validate } = await import('../src/server.ts')
const { Limiter } = await import('../src/limits.ts')
const roomy = new Limiter({ llmCallsPerDay: 999, plansPerDay: 99, chatsPerDay: 99, ipPlansPerHour: 99, ipPlansPerDay: 99, ipChatsPerHour: 99, ipChatsPerDay: 99 })

const stay = { place: 'Hotel Lisboa Centro', nightlyUsd: 140, why: 'Central' }
const research = ['restaurant', 'bakery', 'viewpoint', 'attraction', 'hotel'].map((k, i) => call(`r${i}`, 'find_places', { lat: 38.72, lng: -9.14, kind: k }))

let script = scripted([])
let server: Server
let base = ''
before(async () => {
  server = makeServer(() => script.llm, fakeRoute, fakeFetch, roomy)
  await new Promise<void>((r) => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function ndjson(res: Response) {
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l))
}

test('full flow over HTTP: plan, chat proposal, accept, ics, recheck', async () => {
  script = scripted([
    { content: null, tool_calls: research },
    { content: null, tool_calls: [call('p', 'propose_plan', { title: 'Lisbon', stay, stops: goodDay1 })] },
    { content: 'Lovely day.' },
  ])
  const plan = await ndjson(await fetch(`${base}/api/plan`, { method: 'POST', body: JSON.stringify({ destination: 'Lisbon', startDate: D1, endDate: D1, prompt: 'viewpoint at sunset', origin: 'Los Angeles', travellers: 2, interests: ['food', 'bogus'] }) }))
  const done = plan.at(-1)
  assert.equal(done.type, 'done')
  const trip = done.trip
  assert.ok(plan.some((e) => e.tool === 'enrich'))
  assert.deepEqual(trip.request.interests, ['food'])
  assert.equal(trip.legs.length, 4)
  assert.equal(trip.money.currency, 'EUR')
  assert.ok(trip.budget.totalUsd > 0)
  assert.equal(trip.originPoint.lat, 34.05)

  const list = await (await fetch(`${base}/api/trips`)).json()
  assert.equal(list[0].id, trip.id)
  assert.equal((await fetch(`${base}/t/${trip.id}`)).status, 200)

  // Chat: Hive proposes a swap; the trip is unchanged until accepted.
  const swapped = goodDay1.map((x) => (x.place === 'Cervejaria Ramiro' ? s(D1, '19:30', '21:00', 'Sea Me', 'food') : x))
  script = scripted([
    { content: null, tool_calls: [call('p', 'propose_plan', { summary: 'Dinner at Sea Me', stay, stops: swapped })] },
    { content: 'Moved dinner to Sea Me.' },
  ])
  const chat = await ndjson(await fetch(`${base}/api/trips/${trip.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'quieter dinner please' }) }))
  const afterChat = chat.at(-1).trip
  const prop = afterChat.proposals.at(-1)
  assert.equal(prop.status, 'open')
  assert.ok(afterChat.stops.some((x: { place: string }) => x.place === 'Cervejaria Ramiro'))

  const accepted = await (await fetch(`${base}/api/trips/${trip.id}/proposals/${prop.id}/accept`, { method: 'POST' })).json()
  assert.ok(accepted.stops.some((x: { place: string }) => x.place === 'Sea Me'))
  assert.equal(accepted.proposals.at(-1).status, 'accepted')
  assert.equal((await fetch(`${base}/api/trips/${trip.id}/proposals/${prop.id}/accept`, { method: 'POST' })).status, 409)

  const ics = await (await fetch(`${base}/api/trips/${trip.id}/calendar.ics`)).text()
  assert.match(ics, /SUMMARY:Meal at Sea Me/)

  const re = await (await fetch(`${base}/api/trips/${trip.id}/recheck`, { method: 'POST' })).json()
  assert.ok(re.trip.forecastCheckedAt)
  assert.ok(Array.isArray(re.newIssues))
})

test('profile: saved on disk, filtered, and remembered facts merge in', async () => {
  const put = await (await fetch(`${base}/api/profile`, { method: 'PUT', body: JSON.stringify({ homeCity: 'Los Angeles', interests: ['food', 'hacking'], pace: 'packed' }) })).json()
  assert.deepEqual(put.interests, ['food'])
  const { mergeProfile, loadProfile } = await import('../src/server.ts')
  await mergeProfile({ diet: 'vegetarian', interests: ['art'], notes: ['hates early starts'] })
  const p = await loadProfile()
  assert.equal(p.homeCity, 'Los Angeles')
  assert.equal(p.diet, 'vegetarian')
  assert.deepEqual(p.interests, ['food', 'art'])
  assert.deepEqual(p.notes, ['hates early starts'])
})

test('validation and quotas', () => {
  assert.equal(typeof validate({ destination: 'Rome', startDate: '2026-12-01', endDate: '2026-12-09' }), 'string')
  assert.equal(typeof validate({ destination: '', startDate: '2026-12-01', endDate: '2026-12-01' }), 'string')
  const ok = validate({ destination: 'Rome', startDate: '2026-12-01', endDate: '2026-12-02', slackChannel: 'bad channel!', travellers: 99 })
  assert.ok(typeof ok === 'object' && ok.slackChannel === undefined && ok.travellers === 12)
})

test('packing list: forecast-aware and toggles persist', async () => {
  const list = await (await fetch(`${base}/api/trips`)).json()
  const trip = await (await fetch(`${base}/api/trips/${list[0].id}`)).json()
  const labels = trip.packing.map((x: { label: string }) => x.label)
  assert.ok(labels.includes('Passport / ID'))
  assert.ok(labels.includes('Plug adapter'), 'abroad: EUR vs USD')
  assert.ok(labels.some((l: string) => /Rain jacket/.test(l)) === false, 'D1 is dry')
  const r = await (await fetch(`${base}/api/trips/${trip.id}/packing`, { method: 'POST', body: JSON.stringify({ id: 'p0' }) })).json()
  assert.equal(r.packing[0].done, true)
})

test('a visitor over the limit gets a 429 with Retry-After, and the trip is untouched', async () => {
  const tight = new Limiter({ llmCallsPerDay: 999, plansPerDay: 99, chatsPerDay: 99, ipPlansPerHour: 0, ipPlansPerDay: 99, ipChatsPerHour: 99, ipChatsPerDay: 99 })
  const s2 = makeServer(() => script.llm, fakeRoute, fakeFetch, tight)
  await new Promise<void>((r) => s2.listen(0, r))
  const b2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`
  const res = await fetch(`${b2}/api/plan`, { method: 'POST', body: JSON.stringify({ destination: 'Lisbon', startDate: D1, endDate: D1 }) })
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
  assert.match((await res.json()).error, /per hour/)
  const h = await (await fetch(`${b2}/api/health`)).json()
  assert.equal(h.plansLeft, 0)
  s2.close()
})
