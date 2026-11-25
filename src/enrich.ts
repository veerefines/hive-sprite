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
import type { Leg, Money, PackItem, Stop, Trip, TripRequest } from './types.ts'
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

/** Packing list from the forecast, the plan and the trip length. Deterministic. */
export function computePacking(trip: Trip, previous: PackItem[] = []): PackItem[] {
  const r = trip.request
  const days = tripDays(r)
  const wx = Object.entries(trip.forecast).filter(([d]) => d >= r.startDate && d <= r.endDate).map(([, w]) => w)
  const rainy = wx.some((w) => w.rain || /rain|drizzle|shower|storm/.test(w.desc))
  const cold = wx.length ? Math.min(...wx.map((w) => w.min)) : null
  const hot = wx.length ? Math.max(...wx.map((w) => w.max)) : null
  const walkKm = trip.legs.filter((l) => l.best.mode === 'walk').reduce((s, l) => s + l.best.km, 0)
  const abroad = !!trip.money && trip.money.currency !== trip.money.homeCurrency
  const items: Array<[string, string, string?]> = [
    ['Passport / ID', 'Documents'],
    ...(abroad ? ([['Card with no foreign transaction fees', 'Money', `Paying in ${trip.money!.currency}`]] as Array<[string, string, string]>) : []),
    ...(trip.budget?.cashUsd ? ([[`About ${Math.round((trip.budget.cashUsd * (trip.money?.rates[trip.money.currency] ?? 1)) / 10) * 10} ${trip.money?.currency ?? 'USD'} in cash`, 'Money', 'Hive’s cash estimate']] as Array<[string, string, string]>) : []),
    ['Phone + charger', 'Tech'],
    ...(abroad ? ([['Plug adapter', 'Tech']] as Array<[string, string]>) : []),
    ['Power bank', 'Tech', walkKm > 4 ? `${walkKm.toFixed(1)} km on foot planned` : undefined],
    ['Comfortable walking shoes', 'Clothes', walkKm > 2 ? `${walkKm.toFixed(1)} km of walking legs` : undefined],
    [`${Math.min(days, 7)} days of clothes`, 'Clothes'],
    ...(rainy ? ([['Rain jacket or umbrella', 'Clothes', 'Rain in the forecast']] as Array<[string, string, string]>) : []),
    ...(cold != null && cold <= 10 ? ([['Warm layer', 'Clothes', `Lows of ${cold}°C`]] as Array<[string, string, string]>) : []),
    ...(hot != null && hot >= 26 ? ([['Sunscreen + hat', 'Clothes', `Highs of ${hot}°C`]] as Array<[string, string, string]>) : []),
    ...(trip.stops.some((s) => s.category === 'nightlife') ? ([['One nicer outfit', 'Clothes', 'Evening plans']] as Array<[string, string, string]>) : []),
    ...(trip.stops.some((s) => s.outdoor) ? ([['Reusable water bottle', 'Day bag']] as Array<[string, string]>) : []),
    ['Toiletries + meds', 'Day bag'],
    ...(r.diet ? ([[`Snacks that fit your diet (${r.diet})`, 'Day bag']] as Array<[string, string]>) : []),
  ]
  const done = new Map(previous.map((p) => [p.label, p.done]))
  return items.map(([label, group, why], i) => ({ id: `p${i}`, label, group, why, done: done.get(label) ?? false }))
}

/** Photos for the cover, stay, stops and ideas (Wikipedia/Commons, matched conservatively). */
export async function computePhotos(trip: Trip, f: typeof fetch = fetch): Promise<void> {
  const { photoForDestination, photoForPlace, mapLimit } = await import('./photos.ts')
  if (trip.cover === undefined) trip.cover = (await photoForDestination(trip.request.destination, f)) ?? (trip.center ? await photoForDestination(trip.center.name, f) : null)
  const targets: Array<{ name: string; lat: number; lng: number; kind?: string; set: (p: import('./photos.ts').Photo | null) => void }> = []
  for (const s of trip.stops) if (typeof s.lat === 'number' && s.photo === undefined) targets.push({ name: s.place ?? s.title, lat: s.lat, lng: s.lng!, kind: s.kind, set: (p) => (s.photo = p) })
  if (trip.stay && trip.stay.photo === undefined) targets.push({ name: trip.stay.name, lat: trip.stay.lat, lng: trip.stay.lng, kind: 'hotel', set: (p) => (trip.stay!.photo = p) })
  const ideaList = [...trip.rainyBackups, ...Object.values(trip.ideas).flatMap((l) => l.slice(0, 4))]
  for (const p of ideaList) if (p.photo === undefined) targets.push({ ...p, set: (ph) => (p.photo = ph) })
  await mapLimit(targets.slice(0, 45), 4, async (t) => t.set(await photoForPlace(t, f)))
}
