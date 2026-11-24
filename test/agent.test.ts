import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHive, formatForSlack, type TripRequest } from '../src/agent.ts'
import { gatewayLlm, type ChatMessage, type LlmReply } from '../src/connectors.ts'
import { validate } from '../src/server.ts'

const req: TripRequest = { prompt: 'Food and views', destination: 'Lisbon', startDate: '2026-12-01', endDate: '2026-12-01', pace: 'balanced' }

// Fake public APIs: one geocode hit, a few places, dry weather.
const fakeFetch = (async (input: string | URL) => {
  const u = String(input)
  const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
  if (u.includes('nominatim')) return ok([{ display_name: 'Lisbon, Portugal', lat: '38.72', lon: '-9.14', type: 'city' }])
  if (u.includes('open-meteo'))
    return ok({ daily: { time: ['2026-12-01'], temperature_2m_max: [17], temperature_2m_min: [10], precipitation_probability_max: [10], weather_code: [1], sunset: ['2026-12-01T17:18'] } })
  if (u.includes('overpass')) return ok({ elements: [{ lat: 38.713, lon: -9.133, tags: { name: 'Miradouro' } }] })
  return new Response('nope', { status: 404 })
}) as typeof fetch

const stop = (start: string, end: string, title: string, category: string, lat = 38.71, lng = -9.14) => ({ date: '2026-12-01', start, end, title, category, lat, lng })
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })

test('Hive revises until the Plan Doctor reports no errors', async () => {
  const seen: ChatMessage[][] = []
  const script: LlmReply[] = [
    { content: null, tool_calls: [call('a', 'find_places', { lat: 38.72, lng: -9.14, kind: 'viewpoint' })] },
    // Overlapping stops: the Doctor must flag this.
    { content: null, tool_calls: [call('b', 'propose_plan', { stops: [stop('09:00', '11:00', 'Castle', 'sight'), stop('10:00', '11:30', 'Miradouro', 'sight')] })] },
    {
      content: null,
      tool_calls: [
        call('c', 'propose_plan', {
          stops: [
            stop('08:30', '09:15', 'Pastéis breakfast', 'food'),
            stop('09:30', '11:00', 'Castle', 'sight'),
            stop('12:30', '13:30', 'Lunch at Time Out Market', 'food'),
            stop('15:00', '16:00', 'Miradouro', 'sight', 38.713, -9.133),
            stop('19:30', '21:00', 'Seafood dinner', 'food'),
          ],
        }),
      ],
    },
    { content: 'A relaxed day of views and seafood.' },
  ]
  let i = 0
  const trip = await runHive(req, {
    fetch: fakeFetch,
    llm: async (m) => {
      seen.push(structuredClone(m))
      return script[i++]
    },
  })
  const firstReport = seen[2].at(-1)!.content!
  assert.match(firstReport, /overlap/i, 'first plan should be flagged for overlap')
  assert.equal(trip.issues.filter((x) => x.severity === 'error').length, 0)
  assert.equal(trip.stops.length, 5)
  assert.equal(trip.summary, 'A relaxed day of views and seafood.')
  assert.equal(trip.forecast['2026-12-01'].sunset, '17:18')
  assert.match(seen[0][0].content!, /sunset 17:18/)
  assert.match(formatForSlack(trip), /Hive plan: Lisbon/)
})

test('Slack share goes through the injected connector', async () => {
  const script: LlmReply[] = [
    { content: null, tool_calls: [call('a', 'propose_plan', { stops: [stop('12:00', '13:00', 'Lunch', 'food')] })] },
    { content: 'Done.' },
  ]
  let i = 0
  let posted = ''
  const trip = await runHive({ ...req, slackChannel: '#trips' }, {
    fetch: fakeFetch,
    llm: async () => script[i++],
    slack: async (ch, text) => ((posted = `${ch}|${text}`), { ok: true }),
  })
  assert.equal(trip.shared?.ok, true)
  assert.match(posted, /^#trips\|\*Hive plan/)
})

test('gateway LLM calls the connector URL with no Authorization header', async () => {
  let url = ''
  let headers: Record<string, string> = {}
  const llm = gatewayLlm('https://api.sprites.dev/v1/gateway/openrouter/conn_x/api/v1/', 'm', (async (u: string, init: RequestInit) => {
    url = u
    headers = init.headers as Record<string, string>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
  }) as unknown as typeof fetch)
  const r = await llm([{ role: 'user', content: 'x' }], [])
  assert.equal(url, 'https://api.sprites.dev/v1/gateway/openrouter/conn_x/api/v1/chat/completions')
  assert.equal(Object.keys(headers).some((h) => h.toLowerCase() === 'authorization'), false)
  assert.equal(r.content, 'hi')
})

test('request validation', () => {
  assert.equal(typeof validate({ destination: 'Rome', startDate: '2026-12-01', endDate: '2026-12-09' }), 'string')
  assert.equal(typeof validate({ destination: '', startDate: '2026-12-01', endDate: '2026-12-01' }), 'string')
  const ok = validate({ destination: 'Rome', startDate: '2026-12-01', endDate: '2026-12-02', slackChannel: 'bad channel!' })
  assert.ok(typeof ok === 'object' && ok.slackChannel === undefined)
})

test('find_places uses Photon first and drops far-away or duplicate results', async () => {
  const { findPlaces } = await import('../src/world.ts')
  const feat = (name: string, lat: number, lng: number) => ({ geometry: { coordinates: [lng, lat] }, properties: { name } })
  let overpassCalled = false
  const f = (async (u: string) => {
    if (String(u).includes('photon'))
      return new Response(JSON.stringify({ features: [feat('Miradouro A', 38.71, -9.14), feat('Miradouro A', 38.711, -9.141), feat('Far Away', 40, -8)] }))
    overpassCalled = true
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  const got = await findPlaces(38.708, -9.137, 'viewpoint', 2500, f, 'miradouro')
  assert.deepEqual(got.map((p) => p.name), ['Miradouro A'])
  assert.equal(overpassCalled, false)
})

test('find_places without a keyword lists nearby places by tag (Photon reverse)', async () => {
  const { findPlaces } = await import('../src/world.ts')
  let url = ''
  const f = (async (u: string) => {
    url = String(u)
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-9.14, 38.71] }, properties: { name: 'Miradouro B' } }] }))
  }) as typeof fetch
  const got = await findPlaces(38.708, -9.137, 'viewpoint', 2500, f)
  assert.match(url, /photon\.komoot\.io\/reverse\?.*osm_tag=tourism:viewpoint/)
  assert.deepEqual(got.map((p) => p.name), ['Miradouro B'])
})

test('sunset requests are enforced as an error until a viewpoint sits before sunset', async () => {
  const { requestChecks } = await import('../src/agent.ts')
  const wx = { '2026-12-01': { min: 10, max: 17, desc: 'clear', rain: false, sunset: '17:18' } }
  const r = { ...req, prompt: 'one viewpoint at sunset' }
  const late = [{ id: 'a', ...stop('18:30', '19:30', 'Sunset at Miradouro', 'viewpoint') }]
  const right = [{ id: 'b', ...stop('16:30', '17:30', 'Sunset at Miradouro', 'viewpoint') }]
  assert.equal(requestChecks(r, late, wx)[0]?.severity, 'error')
  assert.deepEqual(requestChecks(r, right, wx), [])
  assert.deepEqual(requestChecks(req, late, wx), [])
})

test('daily quota resets each UTC day', async () => {
  const { takeQuota } = await import('../src/server.ts')
  const d1 = new Date('2030-01-01T10:00:00Z')
  let n = 0
  while (takeQuota(d1)) n++
  assert.equal(n, 40)
  assert.equal(takeQuota(new Date('2030-01-02T00:01:00Z')), true)
})
