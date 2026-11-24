import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHive, reviseTrip, requestChecks, resolvePlace, formatForSlack } from '../src/agent.ts'
import { gatewayLlm } from '../src/connectors.ts'
import { findPlaces } from '../src/world.ts'
import { computeBudget, computeIdeas, computeLegs, computeMoney, toIcs } from '../src/enrich.ts'
import type { TripRequest } from '../src/types.ts'
import { D1, call, fakeFetch, fakeRoute, goodDay1, s, scripted } from './fakes.ts'

const req: TripRequest = { prompt: 'Seafood and a viewpoint at sunset', destination: 'Lisbon', startDate: D1, endDate: D1, pace: 'balanced', travellers: 2, dailyBudget: 150, origin: 'Los Angeles', interests: ['food', 'views'] }
const research = [
  call('r1', 'find_places', { lat: 38.72, lng: -9.14, kind: 'restaurant', keyword: 'seafood' }),
  call('r2', 'find_places', { lat: 38.72, lng: -9.14, kind: 'bakery' }),
  call('r3', 'find_places', { lat: 38.72, lng: -9.14, kind: 'viewpoint' }),
  call('r4', 'find_places', { lat: 38.72, lng: -9.14, kind: 'attraction' }),
  call('r5', 'find_places', { lat: 38.72, lng: -9.14, kind: 'hotel' }),
]
const stay = { place: 'Hotel Lisboa Centro', nightlyUsd: 140, why: 'Central and walkable' }

async function plannedTrip() {
  const { llm, seen } = scripted([
    { content: null, tool_calls: research },
    // Invented place + only 2 meals: both must be errors.
    { content: null, tool_calls: [call('p1', 'propose_plan', { stay, stops: [goodDay1[0], s(D1, '12:30', '13:30', 'Imaginary Bistro', 'food'), goodDay1[1]] })] },
    { content: null, tool_calls: [call('p2', 'propose_plan', { title: 'Lisbon Bites & Views', stay, stops: goodDay1, tips: ['Buy a Viva Viagem card'] })] },
    { content: 'Two days of seafood and views.' },
  ])
  const trip = await runHive(req, { llm, fetch: fakeFetch })
  return { trip, seen }
}

test('plan: Hive researches, the checks reject invented places and missing meals, then it fixes them', async () => {
  const { trip, seen } = await plannedTrip()
  const firstReport = JSON.stringify(seen[2])
  assert.match(firstReport, /Imaginary Bistro.*is not a place Hive found/)
  assert.match(firstReport, /Only 2 meal stop/)
  assert.equal(trip.issues.filter((i) => i.severity === 'error').length, 0)
  assert.equal(trip.title, 'Lisbon Bites & Views')
  assert.equal(trip.stay?.name, 'Hotel Lisboa Centro')
  // Coordinates come from the search result, never from the model.
  const ramiro = trip.stops.find((x) => x.place === 'Cervejaria Ramiro')!
  assert.deepEqual([ramiro.lat, ramiro.lng], [38.7206, -9.1357])
  assert.equal(ramiro.tip, 'Order the garlic prawns')
  assert.deepEqual(trip.tips, ['Buy a Viva Viagem card'])
  assert.ok(Object.keys(trip.known).length >= 8)
  assert.match(formatForSlack(trip), /Lisbon Bites & Views/)
})

test('enrich: legs, money, budget, ideas and calendar', async () => {
  const { trip } = await plannedTrip()
  trip.money = await computeMoney(trip, fakeFetch)
  assert.equal(trip.money.currency, 'EUR')
  assert.equal(trip.money.homeCurrency, 'USD')
  assert.equal(trip.money.live, true)
  trip.legs = await computeLegs(trip, fakeRoute)
  assert.equal(trip.legs.length, 4)
  assert.ok(trip.legs.every((l) => l.path && l.best.minutes > 0 && !l.estimated))
  const budget = computeBudget(trip, { lat: 34.05, lng: -118.24 })
  const cats = budget.lines.map((l) => l.category)
  assert.deepEqual(cats, ['travel', 'stay', 'food', 'local', 'activities', 'shopping', 'buffer'])
  assert.match(budget.lines[0].basis, /flight/i)
  assert.ok(budget.totalUsd > 500)
  const { ideas, rainyBackups } = computeIdeas(trip)
  const ideaNames = Object.values(ideas).flat().map((p) => p.name)
  assert.ok(ideaNames.includes('Sea Me'))
  assert.ok(!ideaNames.includes('Cervejaria Ramiro'))
  assert.ok(!ideaNames.includes('Hotel Lisboa Centro'))
  assert.ok(rainyBackups.every((p) => p.kind !== 'restaurant'))
  const ics = toIcs(trip)
  assert.match(ics, /BEGIN:VCALENDAR/)
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 5)
  assert.match(ics, /DTSTART:20261201T193000/)
})

test('revise: a change comes back as a proposal with a diff, and lasting facts are remembered', async () => {
  const { trip } = await plannedTrip()
  const swapped = goodDay1.map((x) => (x.place === 'Cervejaria Ramiro' ? s(D1, '19:30', '21:00', 'Sea Me', 'food', { costPerPerson: 35 }) : x))
  const { llm } = scripted([
    { content: null, tool_calls: [call('m', 'remember', { diet: 'pescatarian' })] },
    { content: null, tool_calls: [call('p', 'propose_plan', { summary: 'Dinner moved to Sea Me', stay, stops: swapped })] },
    { content: 'Swapped dinner to Sea Me, a quieter seafood spot.' },
  ])
  const remembered: unknown[] = []
  const before = trip.stops.map((x) => x.place)
  const { reply, proposal } = await reviseTrip(trip, 'I am pescatarian, can dinner be somewhere quieter?', { llm, fetch: fakeFetch, remember: (p) => void remembered.push(p) })
  assert.match(reply, /Sea Me/)
  assert.deepEqual(remembered, [{ diet: 'pescatarian' }])
  assert.equal(proposal?.status, 'open')
  assert.equal(proposal?.summary, 'Dinner moved to Sea Me')
  assert.equal(proposal?.diff.added.length, 1)
  assert.equal(proposal?.diff.removed.length, 1)
  assert.deepEqual(trip.stops.map((x) => x.place), before, 'revise never edits the trip itself')
})

test('revise: a plain question gets an answer and no proposal', async () => {
  const { trip } = await plannedTrip()
  const { llm } = scripted([{ content: 'Yes, Castelo de São Jorge takes cards.' }])
  const r = await reviseTrip(trip, 'Can I pay by card at the castle?', { llm, fetch: fakeFetch })
  assert.equal(r.proposal, undefined)
  assert.match(r.reply, /cards/)
})

test('sunset requests are enforced until a viewpoint sits before sunset', () => {
  const wx = { [D1]: { min: 10, max: 17, desc: 'clear', rain: false, sunset: '17:18' } }
  const meals = goodDay1.filter((x) => x.category === 'food').map((x, i) => ({ id: `m${i}`, ...x }))
  const late = [...meals, { id: 'a', ...s(D1, '18:30', '19:20', 'Miradouro da Graça', 'sight') }]
  const right = [...meals, { id: 'b', ...s(D1, '16:30', '17:15', 'Miradouro da Graça', 'sight') }]
  assert.ok(requestChecks(req, late, wx).some((i) => /sunset/.test(i.message)))
  assert.deepEqual(requestChecks(req, right, wx), [])
})

test('place grounding tolerates accents and small wording differences', () => {
  const known = { 'Castelo de São Jorge': { name: 'Castelo de São Jorge', lat: 1, lng: 2, kind: 'attraction' } }
  assert.equal(resolvePlace('castelo de sao jorge', known)?.name, 'Castelo de São Jorge')
  assert.equal(resolvePlace('Visit Castelo de São Jorge', known)?.name, 'Castelo de São Jorge')
  assert.equal(resolvePlace('Torre de Belém', known), null)
})

test('find_places: Photon reverse without keyword, search with keyword, dedupe and radius filter', async () => {
  let url = ''
  const f = (async (u: string) => {
    url = String(u)
    const feat = (name: string, lat: number, lng: number) => ({ geometry: { coordinates: [lng, lat] }, properties: { name } })
    return new Response(JSON.stringify({ features: [feat('Miradouro A', 38.71, -9.14), feat('Miradouro A', 38.711, -9.141), feat('Far Away', 40, -8)] }))
  }) as typeof fetch
  const near = await findPlaces(38.708, -9.137, 'viewpoint', 2500, f)
  assert.match(url, /photon\.komoot\.io\/reverse\?.*osm_tag=tourism:viewpoint/)
  assert.deepEqual(near.map((p) => p.name), ['Miradouro A'])
  await findPlaces(38.708, -9.137, 'restaurant', 2500, f, 'seafood')
  assert.match(url, /photon\.komoot\.io\/api\/\?.*q=seafood/)
})

test('gateway LLM: connector URL, no Authorization header, token cap', async () => {
  let url = ''
  let init: RequestInit = {}
  const llm = gatewayLlm('https://api.sprites.dev/v1/gateway/openrouter/conn_x/v1/', 'm:free', (async (u: string, i: RequestInit) => {
    url = u
    init = i
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
  }) as unknown as typeof fetch, 1234)
  const r = await llm([{ role: 'user', content: 'x' }], [])
  assert.equal(url, 'https://api.sprites.dev/v1/gateway/openrouter/conn_x/v1/chat/completions')
  assert.equal(Object.keys(init.headers as object).some((h) => h.toLowerCase() === 'authorization'), false)
  assert.equal(JSON.parse(String(init.body)).max_tokens, 1234)
  assert.equal(r.content, 'hi')
})

test('an early dinner is sent back to the model', () => {
  const wx = { [D1]: { min: 10, max: 17, desc: 'clear', rain: false } }
  const early = goodDay1.map((x, i) => ({ id: `e${i}`, ...(x.place === 'Cervejaria Ramiro' ? { ...x, start: '17:00', end: '18:00' } : x) }))
  assert.ok(requestChecks({ ...req, prompt: '' }, early, wx).some((i) => /too early/.test(i.message)))
  const fine = goodDay1.map((x, i) => ({ id: `f${i}`, ...x }))
  assert.deepEqual(requestChecks({ ...req, prompt: '' }, fine, wx), [])
})

test('free-tier economy: research runs in code, and a search-happy model is made to draft', async () => {
  const toolSets: string[][] = []
  const search = { content: null, tool_calls: [call('s', 'find_places', { lat: 38.72, lng: -9.14, kind: 'restaurant', keyword: 'more' })] }
  let i = 0
  const llm = (async (msgs: Array<{ content: string | null }>, tools: Array<{ function: { name: string } }>) => {
    toolSets.push(tools.map((t) => t.function.name))
    i++
    if (i === 1) assert.match(String(msgs[1].content), /Shortlist of real places[\s\S]*Hotel Lisboa Centro[\s\S]*Cervejaria Ramiro/)
    if (tools.length > 1) return search
    if (tools.length === 0) return { content: 'done' }
    if (i < 10) return { content: null, tool_calls: [call('p', 'propose_plan', { title: 'T', stay: { place: 'Hotel Lisboa Centro', why: 'x' }, stops: goodDay1 })] }
    return { content: 'done' }
  }) as never
  const trip = await runHive({ ...req, prompt: 'food' }, { llm, fetch: fakeFetch, researchBudget: 2, maxSteps: 8 })
  assert.deepEqual(toolSets.slice(0, 2).map((t) => t.length > 1), [true, true])
  assert.deepEqual(toolSets[2], ['propose_plan'], 'after 2 searches only propose_plan is offered')
  assert.equal(trip.stops.length, 5)
  assert.ok(toolSets.length <= 5, `took ${toolSets.length} model calls`)
})
