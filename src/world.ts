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

const KINDS: Record<string, string> = {
  restaurant: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  museum: '["tourism"="museum"]',
  attraction: '["tourism"="attraction"]',
  viewpoint: '["tourism"="viewpoint"]',
  park: '["leisure"="park"]',
  bar: '["amenity"="bar"]',
  market: '["amenity"="marketplace"]',
}

export async function findPlaces(
  lat: number,
  lng: number,
  kind: string,
  radiusM = 2500,
  fetchImpl: typeof fetch = fetch,
): Promise<Place[]> {
  const filter = KINDS[kind] ?? KINDS.attraction
  const q = `[out:json][timeout:20];nwr${filter}["name"](around:${Math.min(radiusM, 8000)},${lat},${lng});out center 15;`
  const res = await fetchImpl('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: `data=${encodeURIComponent(q)}`,
  })
  if (!res.ok) return []
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
    .slice(0, 12)
}

export interface DayWeather {
  min: number
  max: number
  desc: string
  rain: boolean
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
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=16&timezone=auto'
  const res = await fetchImpl(url)
  if (!res.ok) return {}
  const d = (await res.json()) as {
    daily: {
      time: string[]
      temperature_2m_max: number[]
      temperature_2m_min: number[]
      precipitation_probability_max: number[]
      weather_code: number[]
    }
  }
  const out: Record<string, DayWeather> = {}
  d.daily.time.forEach((day, i) => {
    out[day] = {
      max: Math.round(d.daily.temperature_2m_max[i]),
      min: Math.round(d.daily.temperature_2m_min[i]),
      desc: WMO[d.daily.weather_code[i]] ?? 'mixed',
      rain: (d.daily.precipitation_probability_max[i] ?? 0) >= 50,
    }
  })
  return out
}
