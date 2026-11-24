import type { LlmReply } from '../src/connectors.ts'

export const D1 = '2026-12-01'
export const D2 = '2026-12-02'

const feat = (name: string, lat: number, lng: number, street = 'Rua X') => ({ geometry: { coordinates: [lng, lat] }, properties: { name, street } })

/** Photon results per OSM tag, all around Lisbon's centre. */
const BY_TAG: Record<string, ReturnType<typeof feat>[]> = {
  'amenity:restaurant': [feat('Cervejaria Ramiro', 38.7206, -9.1357), feat('Taberna da Rua das Flores', 38.7104, -9.1430), feat('Sea Me', 38.7108, -9.1452), feat('A Cevicheria', 38.7155, -9.1490)],
  'amenity:cafe': [feat('Fabrica Coffee Roasters', 38.7135, -9.1405), feat('Copenhagen Coffee Lab', 38.7101, -9.1440)],
  'shop:bakery': [feat('Manteigaria', 38.7106, -9.1436), feat('Pastelaria Alcoa', 38.7098, -9.1418)],
  'tourism:viewpoint': [feat('Miradouro da Graça', 38.7166, -9.1310), feat('Miradouro de Santa Catarina', 38.7090, -9.1475)],
  'tourism:attraction': [feat('Castelo de São Jorge', 38.7139, -9.1335)],
  'tourism:museum': [feat('Museu do Azulejo', 38.7247, -9.1136), feat('MUDE', 38.7096, -9.1370)],
  'tourism:hotel': [feat('Hotel Lisboa Centro', 38.7160, -9.1400)],
}

export const fakeFetch = (async (input: string | URL) => {
  const u = String(input)
  const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
  if (u.includes('nominatim')) {
    if (u.includes('Los%20Angeles')) return ok([{ display_name: 'Los Angeles, California, United States', lat: '34.05', lon: '-118.24', type: 'city' }])
    return ok([{ display_name: 'Lisboa, Portugal', lat: '38.72', lon: '-9.14', type: 'city' }])
  }
  if (u.includes('open-meteo'))
    return ok({
      daily: {
        time: [D1, D2],
        temperature_2m_max: [17, 16],
        temperature_2m_min: [10, 9],
        precipitation_probability_max: [10, 80],
        weather_code: [1, 61],
        sunset: [`${D1}T17:18`, `${D2}T17:17`],
      },
    })
  if (u.includes('photon')) {
    const tag = decodeURIComponent(/osm_tag=([^&]+)/.exec(u)?.[1] ?? '')
    return ok({ type: 'FeatureCollection', features: BY_TAG[tag] ?? [] })
  }
  if (u.includes('frankfurter')) return ok({ base: 'USD', rates: { EUR: 0.9, INR: 92 } })
  return new Response('nope', { status: 404 })
}) as typeof fetch

/** Straight-line "router" so tests never touch the network. */
export const fakeRoute = async (profile: 'foot' | 'car', a: { lat: number; lng: number }, b: { lat: number; lng: number }) => ({
  path: [[a.lat, a.lng], [b.lat, b.lng]] as Array<[number, number]>,
  minutes: profile === 'foot' ? 12 : 6,
  km: 1,
})

export const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })

export const s = (date: string, start: string, end: string, place: string, category: string, extra: Record<string, unknown> = {}) => ({
  date,
  start,
  end,
  place,
  title: category === 'food' ? `Meal at ${place}` : place,
  category,
  note: 'fits you',
  ...extra,
})

export const goodDay1 = [
  s(D1, '08:30', '09:15', 'Manteigaria', 'food', { costPerPerson: 5 }),
  s(D1, '09:45', '11:15', 'Castelo de São Jorge', 'sight', { costPerPerson: 15, outdoor: true }),
  s(D1, '12:30', '13:30', 'Taberna da Rua das Flores', 'food', { costPerPerson: 25 }),
  s(D1, '16:30', '17:15', 'Miradouro de Santa Catarina', 'sight', { outdoor: true }),
  s(D1, '19:30', '21:00', 'Cervejaria Ramiro', 'food', { costPerPerson: 40, tip: 'Order the garlic prawns' }),
]

export function scripted(replies: LlmReply[]) {
  let i = 0
  const seen: unknown[][] = []
  const llm = async (m: unknown[]) => {
    seen.push(structuredClone(m))
    const r = replies[Math.min(i++, replies.length - 1)]
    return r
  }
  return { llm: llm as never, seen }
}
