/**
 * Keyless public data: geocoding (Nominatim), places (Overpass) and weather
 * (Open-Meteo). No credentials, so these are called directly.
 */

const UA = 'hive-sprite/0.1 (Fly.io Hacksgiving entry; github.com/veerefines/hive-sprite)'

export interface Place {
  name: string
  lat: number
  lng: number
  kind: string
  address?: string
}

export async function geocode(query: string, fetchImpl: typeof fetch = fetch): Promise<Place | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`
  const res = await fetchImpl(url, { headers: { 'user-agent': UA } })
  if (!res.ok) return null
  const rows = (await res.json()) as Array<{ display_name: string; lat: string; lon: string; type: string }>
  const r = rows[0]
  if (!r) return null
  return { name: r.display_name.split(',')[0], lat: Number(r.lat), lng: Number(r.lon), kind: r.type, address: r.display_name }
}

// kind -> [Photon osm_tag, search word, Overpass filter]
const KINDS: Record<string, [string, string, string]> = {
  restaurant: ['amenity:restaurant', 'restaurant', '["amenity"="restaurant"]'],
  cafe: ['amenity:cafe', 'cafe', '["amenity"="cafe"]'],
  museum: ['tourism:museum', 'museum', '["tourism"="museum"]'],
  attraction: ['tourism:attraction', 'attraction', '["tourism"="attraction"]'],
  viewpoint: ['tourism:viewpoint', 'viewpoint', '["tourism"="viewpoint"]'],
  park: ['leisure:park', 'park', '["leisure"="park"]'],
  bar: ['amenity:bar', 'bar', '["amenity"="bar"]'],
  market: ['amenity:marketplace', 'market', '["amenity"="marketplace"]'],
}

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

async function withTimeout(p: (signal: AbortSignal) => Promise<Response>, ms: number): Promise<Response | null> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await p(ctl.signal)
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * Photon (komoot's OpenStreetMap search). With a keyword it does a
 * location-biased text search; without one it lists the nearest places with
 * the OSM tag (reverse mode), which needs no search word at all.
 */
async function photon(lat: number, lng: number, kind: string, keyword: string, radiusKm: number, f: typeof fetch): Promise<Place[]> {
  const [tag] = KINDS[kind] ?? KINDS.attraction
  const url = keyword
    ? `https://photon.komoot.io/api/?lat=${lat}&lon=${lng}&limit=25&osm_tag=${tag}&q=${encodeURIComponent(keyword)}`
    : `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=20&osm_tag=${tag}&radius=${Math.max(1, Math.round(radiusKm))}`
  const res = await withTimeout((signal) => f(url, { headers: { 'user-agent': UA }, signal }), 8000)
  if (!res?.ok) return []
  const data = (await res.json()) as {
    features: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }>
  }
  return data.features
    .map((ft) => ({
      name: ft.properties.name ?? '',
      lat: ft.geometry.coordinates[1],
      lng: ft.geometry.coordinates[0],
      kind,
      address: [ft.properties.street, ft.properties.housenumber, ft.properties.district].filter(Boolean).join(' ') || undefined,
    }))
    .filter((p) => p.name && km(lat, lng, p.lat, p.lng) <= radiusKm)
}

/** Overpass fallback: exact radius query, but the public instance is often slow. */
async function overpass(lat: number, lng: number, kind: string, radiusM: number, f: typeof fetch): Promise<Place[]> {
  const filter = (KINDS[kind] ?? KINDS.attraction)[2]
  const q = `[out:json][timeout:8];nwr${filter}["name"](around:${radiusM},${lat},${lng});out center 15;`
  const res = await withTimeout(
    (signal) =>
      f('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(q)}`,
        signal,
      }),
    10000,
  )
  if (!res?.ok) return []
  const data = (await res.json()) as {
    elements: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }>
  }
  return data.elements
    .map((e) => ({
      name: e.tags?.name ?? '',
      lat: e.lat ?? e.center?.lat ?? NaN,
      lng: e.lon ?? e.center?.lon ?? NaN,
      kind,
      address: [e.tags?.['addr:street'], e.tags?.['addr:housenumber']].filter(Boolean).join(' ') || undefined,
    }))
    .filter((p) => p.name && Number.isFinite(p.lat))
}

export async function findPlaces(
  lat: number,
  lng: number,
  kind: string,
  radiusM = 2500,
  fetchImpl: typeof fetch = fetch,
  keyword = '',
): Promise<Place[]> {
  const r = Math.min(Math.max(radiusM, 500), 8000)
  let places = await photon(lat, lng, kind, keyword, (r / 1000) * 1.5, fetchImpl).catch(() => [])
  if (!places.length && keyword) places = await photon(lat, lng, kind, '', (r / 1000) * 1.5, fetchImpl).catch(() => [])  // nearby, no keyword
  if (!places.length) places = await overpass(lat, lng, kind, r, fetchImpl).catch(() => [])
  const seen = new Set<string>()
  return places.filter((p) => !seen.has(p.name) && seen.add(p.name)).slice(0, 12)
}

export interface DayWeather {
  min: number
  max: number
  desc: string
  rain: boolean
  sunset?: string // HH:MM local
}

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'rain', 63: 'rain', 65: 'heavy rain',
  71: 'snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorm',
}

export async function forecast(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, DayWeather>> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunset&forecast_days=16&timezone=auto'
  const res = await fetchImpl(url)
  if (!res.ok) return {}
  const d = (await res.json()) as {
    daily: {
      time: string[]
      temperature_2m_max: number[]
      temperature_2m_min: number[]
      precipitation_probability_max: number[]
      weather_code: number[]
      sunset?: string[]
    }
  }
  const out: Record<string, DayWeather> = {}
  d.daily.time.forEach((day, i) => {
    out[day] = {
      max: Math.round(d.daily.temperature_2m_max[i]),
      min: Math.round(d.daily.temperature_2m_min[i]),
      desc: WMO[d.daily.weather_code[i]] ?? 'mixed',
      rain: (d.daily.precipitation_probability_max[i] ?? 0) >= 50,
      sunset: d.daily.sunset?.[i]?.slice(11, 16) || undefined,
    }
  })
  return out
}
