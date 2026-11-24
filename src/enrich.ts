/**
 * Everything Hive adds after the itinerary is settled, all deterministic:
 * best way between stops (+ street routes), money (currency, live FX),
 * the whole-trip cost estimate, leftover ideas, rainy-day backups, and
 * the calendar export.
 */
import { chooseLeg, tierFromDailyBudget, type Pace as LegPace } from './lib/legs.ts'
import { routeBetween, type RoutedPath, type RouteProfile } from './lib/routing.ts'
import { estimateTrip, cashToCarryUsd } from './lib/budget.ts'
import { countryFor, FALLBACK_USD_RATES } from './lib/money.ts'
import { haversineKm, type LatLng } from './lib/geo.ts'
import { sortDay, groupByDate, toMinutes } from './lib/planCheck.ts'
import type { Leg, Money, Stop, Trip, TripRequest } from './types.ts'
import type { Place } from './world.ts'

export type Router = (profile: RouteProfile, a: LatLng, b: LatLng) => Promise<RoutedPath | null>

const LEG_PACE: Record<string, LegPace> = { chill: 'relaxed', balanced: 'balanced', packed: 'packed' }
const INDOOR = new Set(['museum', 'cafe', 'market', 'gallery', 'restaurant'])

export function travellers(r: TripRequest): number {
  return Math.min(12, Math.max(1, Math.round(r.travellers ?? 1)))
}

export function tripDays(r: TripRequest): number {
  return Math.round((Date.parse(r.endDate) - Date.parse(r.startDate)) / 86_400_000) + 1
}

/** Best way between consecutive stops each day, with street geometry when the router answers. */
export async function computeLegs(trip: Trip, route: Router = routeBetween, priceIndex = 1): Promise<Leg[]> {
  const r = trip.request
  const pairs: Array<{ date: string; a: Stop; b: Stop }> = []
  for (const [date, stops] of groupByDate(trip.stops)) {
    const day = sortDay(stops).filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    for (let i = 1; i < day.length; i++) pairs.push({ date, a: day[i - 1], b: day[i] })
  }
  const legs = await Promise.all(
    pairs.map(async ({ date, a, b }) => {
      const A = { lat: a.lat!, lng: a.lng! }
      const B = { lat: b.lat!, lng: b.lng! }
      const crow = haversineKm(A, B)
      const [foot, car] = await Promise.all([
        crow < 6 ? route('foot', A, B).catch(() => null) : Promise.resolve(null),
        crow >= 0.8 ? route('car', A, B).catch(() => null) : Promise.resolve(null),
      ])
      const start = toMinutes(b.start)
      const choice = chooseLeg(A, B, {
        index: priceIndex,
        tier: tierFromDailyBudget(r.dailyBudget),
        pace: LEG_PACE[r.pace ?? 'balanced'],
        travellers: travellers(r),
        walkMinutes: foot?.minutes,
        walkKm: foot?.km,
        driveMinutes: car?.minutes,
        driveKm: car?.km,
        rainy: trip.forecast[date]?.rain,
        night: start != null && start >= 20 * 60,
      })
      const path = choice.best.mode === 'walk' ? foot?.path : (car?.path ?? foot?.path)
      return {
        date,
        fromId: a.id,
        toId: b.id,
        best: choice.best,
        options: choice.options,
        why: choice.why,
        path: path ? thin(path, 160) : undefined,
        estimated: !(choice.best.mode === 'walk' ? foot : car),
      } satisfies Leg
    }),
  )
  return legs
}

/** Keep at most n points of a polyline (start and end always kept). */
function thin(path: Array<[number, number]>, n: number): Array<[number, number]> {
  if (path.length <= n) return path.map(([a, b]) => [round5(a), round5(b)])
  const step = (path.length - 1) / (n - 1)
  return Array.from({ length: n }, (_, i) => path[Math.round(i * step)]).map(([a, b]) => [round5(a), round5(b)])
}
const round5 = (x: number) => Math.round(x * 1e5) / 1e5

/** Destination currency + home currency + FX (Frankfurter, offline fallback). */
export async function computeMoney(trip: Trip, f: typeof fetch = fetch): Promise<Money> {
  const dest = countryFor(trip.center?.address ?? trip.request.destination)
  const home = countryFor(trip.request.origin)
  const currency = dest?.currency ?? 'USD'
  const homeCurrency = home?.currency ?? 'USD'
  let rates: Record<string, number> = { ...FALLBACK_USD_RATES }
  let live = false
  try {
    const res = await f('https://api.frankfurter.app/latest?from=USD', { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = (await res.json()) as { rates?: Record<string, number> }
      if (data.rates) {
        rates = { ...rates, ...data.rates, USD: 1 }
        live = true
      }
    }
  } catch {
    /* offline fallback rates */
  }
  return { country: dest?.name, currency, homeCurrency, rates, live, cashShare: dest?.cashShare }
}

export function computeBudget(trip: Trip, origin: LatLng | null) {
  const r = trip.request
  const days = tripDays(r)
  const t = travellers(r)
  const index = countryFor(trip.center?.address ?? r.destination)?.index ?? 1
  const nights = Math.max(0, days - 1)
  const stayStops = trip.stay?.nightlyUsd
    ? [{ category: 'stay', costPerPerson: Math.round((trip.stay.nightlyUsd * nights * Math.ceil(t / 2)) / t) }]
    : []
  const est = estimateTrip({
    days,
    travellers: t,
    tier: tierFromDailyBudget(r.dailyBudget),
    index,
    stops: [
      ...trip.stops.map((s) => ({ category: s.category === 'food' ? 'food' : 'activity', costPerPerson: s.costPerPerson })),
      ...stayStops,
    ],
    legsUsd: trip.legs.reduce((sum, l) => sum + l.best.usd, 0),
    origin,
    destination: trip.center ?? null,
  })
  const cashUsd = trip.money?.cashShare != null ? Math.round(cashToCarryUsd(est, trip.money.cashShare)) : undefined
  return { ...est, cashUsd }
}

/** Places Hive found but didn't use, by kind, plus indoor options for wet days. */
export function computeIdeas(trip: Trip): { ideas: Record<string, Place[]>; rainyBackups: Place[] } {
  const used = new Set(trip.stops.map((s) => (s.place ?? s.title).toLowerCase()))
  if (trip.stay) used.add(trip.stay.name.toLowerCase())
  const unused = Object.values(trip.known).filter((p) => !used.has(p.name.toLowerCase()) && p.kind !== 'hotel')
  const ideas: Record<string, Place[]> = {}
  for (const p of unused) (ideas[p.kind] ??= []).length < 6 && ideas[p.kind].push(p)
  const rainyBackups = unused.filter((p) => INDOOR.has(p.kind) && p.kind !== 'restaurant').slice(0, 6)
  return { ideas, rainyBackups }
}

function icsDate(date: string, hhmm: string): string {
  return `${date.replaceAll('-', '')}T${hhmm.replace(':', '')}00`
}
function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n')
}

/** Floating-time iCalendar: events land at the local time of the trip. */
export function toIcs(trip: Trip): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hive on a Sprite//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(trip.title)}`]
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  for (const s of trip.stops) {
    if (!s.start) continue
    const end = s.end ?? s.start
    lines.push(
      'BEGIN:VEVENT',
      `UID:${trip.id}-${s.id}@hive`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(s.date, s.start)}`,
      `DTEND:${icsDate(s.date, end)}`,
      `SUMMARY:${icsText(s.title)}`,
      ...(s.note || s.tip ? [`DESCRIPTION:${icsText([s.note, s.tip && `Tip: ${s.tip}`].filter(Boolean).join('\n'))}`] : []),
      ...(s.address ? [`LOCATION:${icsText(s.address)}`] : []),
      ...(typeof s.lat === 'number' ? [`GEO:${s.lat};${s.lng}`] : []),
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
