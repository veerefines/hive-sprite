/**
 * Photos from Wikipedia / Wikimedia Commons: keyless, free, credited.
 *
 * A place only gets a photo when we're confident it shows that place: the
 * Wikipedia article's title matches the place name, or (for landmarks) the
 * article sits within a few dozen metres. Restaurants and cafés rarely have
 * articles, so most of them get none and the UI draws a category card instead
 * of a misleading photo.
 */
import { haversineKm } from './lib/geo.ts'

export interface Photo {
  url: string
  /** The Wikipedia article the image comes from (credit link). */
  page: string
  title: string
}

const UA = 'hive-sprite/0.2 (Fly.io Hacksgiving entry; https://github.com/veerefines/hive-sprite)'
const LANDMARK = new Set(['attraction', 'viewpoint', 'museum', 'gallery', 'park', 'market'])

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'the', 'of', 'la', 'le', 'el', 'and', 'e', 'di', 'del', 'des', 'du', 'restaurant', 'cafe'])
function tokens(s: string): string[] {
  return norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t))
}

/** Share of the place name's words found in the article title. */
export function nameMatch(place: string, title: string): number {
  const a = tokens(place)
  if (!a.length) return 0
  const b = new Set(tokens(title))
  return a.filter((t) => b.has(t)).length / a.length
}

/** Pick the article that really is this place, or none. */
export function pickPhoto(
  place: { name: string; lat: number; lng: number; kind?: string },
  pages: Array<{ title: string; lat: number; lng: number; thumb?: string }>,
): Photo | null {
  let best: { p: (typeof pages)[number]; score: number } | null = null
  for (const p of pages) {
    if (!p.thumb) continue
    const m = nameMatch(place.name, p.title)
    const km = haversineKm(place, p)
    let score = 0
    if ((m === 1 && km < 1.5) || (m >= 0.6 && km < 0.4)) score = 2 + m
    else if (LANDMARK.has(place.kind ?? '') && km < 0.06 && m >= 0.3) score = 1 + m
    if (score && (!best || score > best.score)) best = { p, score }
  }
  return best ? { url: best.p.thumb!, page: `https://en.wikipedia.org/wiki/${encodeURIComponent(best.p.title.replace(/ /g, '_'))}`, title: best.p.title } : null
}

export async function photoForPlace(
  place: { name: string; lat: number; lng: number; kind?: string },
  f: typeof fetch = fetch,
): Promise<Photo | null> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=geosearch' +
    `&ggscoord=${place.lat.toFixed(5)}%7C${place.lng.toFixed(5)}&ggsradius=600&ggslimit=12` +
    '&prop=pageimages%7Ccoordinates&piprop=thumbnail&pithumbsize=500&pilimit=12&origin=*'
  try {
    const res = await f(url, { headers: { 'user-agent': UA } })
    if (!res.ok) return null
    const data = (await res.json()) as {
      query?: { pages?: Array<{ title: string; coordinates?: Array<{ lat: number; lon: number }>; thumbnail?: { source: string } }> }
    }
    const pages = (data.query?.pages ?? [])
      .filter((p) => p.coordinates?.[0])
      .map((p) => ({ title: p.title, lat: p.coordinates![0].lat, lng: p.coordinates![0].lon, thumb: p.thumbnail?.source }))
    return pickPhoto(place, pages)
  } catch {
    return null
  }
}

/** Cover photo for a destination from its Wikipedia summary. */
export async function photoForDestination(name: string, f: typeof fetch = fetch): Promise<Photo | null> {
  const title = name.split(',')[0].trim()
  if (!title) return null
  try {
    const res = await f(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`, { headers: { 'user-agent': UA } })
    if (!res.ok) return null
    const d = (await res.json()) as { type?: string; title?: string; originalimage?: { source: string; width: number }; thumbnail?: { source: string }; content_urls?: { desktop?: { page?: string } } }
    if (d.type === 'disambiguation') return null
    // Wikimedia only serves standard thumbnail widths (330, 500, 960, 1280, 1920, 3840).
    const width = d.originalimage?.width ?? 0
    const src = width >= 1280 ? d.thumbnail?.source?.replace(/\/\d+px-/, '/1280px-') : (d.originalimage?.source ?? d.thumbnail?.source)
    if (!src) return null
    return { url: src, page: d.content_urls?.desktop?.page ?? '', title: d.title ?? title }
  } catch {
    return null
  }
}

/** Run fn over items with at most `n` in flight. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}
