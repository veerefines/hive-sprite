/**
 * Hive: a personal trip agent that lives on a Fly.io Sprite.
 *
 * plan:   research real places → draft a full trip (stay, every meal, sights,
 *         notes, tips) → Plan Doctor + Hive's own checks → revise until clean.
 * revise: chat about an existing trip. Hive answers, and when a change is
 *         needed it drafts a revised plan that must also pass the checks.
 *         The revision is stored as a proposal the traveller accepts or rejects.
 */
import { randomUUID } from 'node:crypto'
import { checkPlan, groupByDate, sortDay, toMinutes, type Issue, type PrefLike } from './lib/planCheck.ts'
import { slackPost, type ChatMessage, type Llm, type ToolSpec } from './connectors.ts'
import { findPlaces, forecast, geocode, PLACE_KINDS, type DayWeather, type Place } from './world.ts'
import { haversineKm } from './lib/geo.ts'
import type { Proposal, Stay, Stop, Trip, TripRequest } from './types.ts'

export type { TripRequest } from './types.ts'

export interface Profile {
  homeCity?: string
  diet?: string
  interests?: string[]
  pace?: string
  dailyBudget?: number
  notes?: string[]
}

export interface AgentDeps {
  llm: Llm
  fetch?: typeof fetch
  slack?: typeof slackPost
  maxSteps?: number
  onStep?: (entry: { step: number; tool: string; note: string }) => void
  /** Extra find_places calls the model may make before it must draft (default 3). */
  researchBudget?: number
  profile?: Profile
  remember?: (patch: Profile) => Promise<void> | void
}

const STOP_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD' },
    start: { type: 'string', description: 'HH:MM' },
    end: { type: 'string', description: 'HH:MM' },
    place: { type: 'string', description: 'The place ID from the shortlist or find_places, e.g. "P12"' },
    title: { type: 'string', description: 'Short label, e.g. "Seafood lunch at Cervejaria Ramiro"' },
    category: { type: 'string', enum: ['food', 'sight', 'activity', 'nightlife', 'shopping'] },
    costPerPerson: { type: 'number', description: 'Estimated USD per person' },
    outdoor: { type: 'boolean' },
    note: { type: 'string', description: 'One line: why this stop fits this traveller' },
    tip: { type: 'string', description: 'One practical local tip (what to order, when to go, booking)' },
  },
  required: ['date', 'start', 'end', 'place', 'title', 'category', 'note'],
}

const PLAN_PARAMS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Catchy trip title, max 6 words' },
    summary: { type: 'string', description: 'For revisions: one line describing what changed' },
    stay: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'The ID of a hotel or hostel from the shortlist, e.g. "P3"' },
        nightlyUsd: { type: 'number', description: 'Estimated USD per room per night' },
        why: { type: 'string' },
      },
      required: ['place', 'why'],
    },
    stops: { type: 'array', items: STOP_SCHEMA },
    tips: { type: 'array', items: { type: 'string' }, description: '3-5 trip-wide tips (transport passes, customs, what to pack)' },
  },
  required: ['stops'],
}

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'geocode',
      description: 'Find coordinates for a city, neighbourhood or named place.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_places',
      description: 'List real named places near a point from OpenStreetMap. Call it many times: each kind, plus keywords for the traveller\'s interests.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          kind: { type: 'string', enum: PLACE_KINDS },
          keyword: { type: 'string', description: 'Optional, e.g. "seafood", "pastry", "fado", "vegan"' },
          radius_m: { type: 'number' },
        },
        required: ['lat', 'lng', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description:
        'Submit the WHOLE itinerary (every day, every stop) plus the stay and tips. Returns the Plan Doctor report. Fix every error and resubmit.',
      parameters: PLAN_PARAMS,
    },
  },
]

const REMEMBER: ToolSpec = {
  type: 'function',
  function: {
    name: 'remember',
    description: 'Save a lasting fact about the traveller (diet, home city, interests, pace, budget) for future trips. Only for things they said about themselves.',
    parameters: {
      type: 'object',
      properties: {
        homeCity: { type: 'string' },
        diet: { type: 'string' },
        interests: { type: 'array', items: { type: 'string' } },
        pace: { type: 'string', enum: ['chill', 'balanced', 'packed'] },
        dailyBudget: { type: 'number' },
        note: { type: 'string' },
      },
    },
  },
}

// ---------- prompts ----------

function forecastLines(r: TripRequest, weather: Record<string, DayWeather>): string {
  return Object.entries(weather)
    .filter(([d]) => d >= r.startDate && d <= r.endDate)
    .map(([d, w]) => `${d}: ${w.desc}, ${w.min}-${w.max}°C${w.rain ? ', likely rain' : ''}${w.sunset ? `, sunset ${w.sunset}` : ''}`)
    .join('\n')
}

function profileLines(p?: Profile): string {
  if (!p) return ''
  const bits = [
    p.homeCity && `home: ${p.homeCity}`,
    p.diet && `diet: ${p.diet}`,
    p.interests?.length && `loves: ${p.interests.join(', ')}`,
    ...(p.notes ?? []).slice(-5),
  ].filter(Boolean)
  return bits.length ? `What Hive remembers about this traveller: ${bits.join('; ')}.` : ''
}

const RULES = [
  'Every stop and the stay must set "place" to the ID of a real place (e.g. "P12") from the shortlist or find_places. Never invent places.',
  'Each day: breakfast, lunch and dinner at real restaurants/cafes/bakeries, plus sights or activities that fit the interests. No place twice in the trip.',
  'Meal times: breakfast 07:30-10:00, lunch 12:00-14:30, dinner starts 18:30-21:00 (later where locals eat late, e.g. Spain).',
  'Keep stops in the same area per day, leave 15-30 min between stops for travel, respect the pace (chill 3-4 timed stops, balanced 5-6, packed 7-8 including meals).',
  'Outdoor stops on dry days; on rainy days prefer museums, galleries, markets, cafes.',
  'Honour every specific request in the traveller\'s note. "At sunset" means the stop starts about 30-45 min before that day\'s sunset.',
  'Respect the diet in every food stop (pick places whose name or kind suits it, mention it in the note).',
  'note = why this fits THEM; tip = concrete local advice. Pick one stay (hotel/hostel matching the budget) central to the plan.',
]

function planPrompt(r: TripRequest, weather: Record<string, DayWeather>, profile?: Profile): string {
  const wx = forecastLines(r, weather)
  return [
    'You are Hive, a personal trip-planning agent running on a Fly.io Sprite.',
    `Plan ${r.destination} from ${r.startDate} to ${r.endDate} for ${r.travellers ?? 1} traveller(s).`,
    `Pace: ${r.pace ?? 'balanced'}. Daily budget per person: ${r.dailyBudget ? `$${r.dailyBudget}` : 'not set'}. Wake time: ${r.wakeTime ?? '08:00'}.`,
    r.interests?.length ? `Interests: ${r.interests.join(', ')}.` : '',
    r.diet ? `Diet: ${r.diet}.` : '',
    r.origin ? `Coming from ${r.origin}.` : '',
    profileLines(profile),
    wx ? `Forecast:\n${wx}` : 'No forecast yet for these dates (too far ahead); plan for typical weather.',
    'A shortlist of real places is provided. Search more only if something specific is missing (e.g. "ramen", "tea house"); call several find_places at once if you need them.',
    ...RULES,
    'Then call propose_plan with the WHOLE trip, read the Plan Doctor report, fix every error and resubmit.',
    'When the report has no errors, reply with a warm 2-3 sentence summary of the trip (no tool call).',
  ]
    .filter(Boolean)
    .join('\n')
}

function planAsText(t: Trip): string {
  const lines: string[] = []
  if (t.stay) lines.push(`Stay: ${t.stay.name}${t.stay.nightlyUsd ? ` (~$${t.stay.nightlyUsd}/night)` : ''}`)
  for (const [date, stops] of [...groupByDate(t.stops).entries()].sort()) {
    lines.push(`${date}:`)
    for (const s of sortDay(stops)) lines.push(`  ${s.start}-${s.end} ${s.title} [place: ${t.known[s.place ?? '']?.id ?? s.place ?? s.title}; ${s.category}; $${s.costPerPerson ?? 0}${s.outdoor ? '; outdoor' : ''}]`)
  }
  return lines.join('\n')
}

function revisePrompt(t: Trip, profile?: Profile): string {
  const r = t.request
  return [
    'You are Hive, the traveller\'s personal trip agent on a Fly.io Sprite. You are chatting about their existing trip.',
    `Trip: ${r.destination}, ${r.startDate} to ${r.endDate}, ${r.travellers ?? 1} traveller(s), pace ${r.pace ?? 'balanced'}, budget ${r.dailyBudget ? `$${r.dailyBudget}/day` : 'not set'}.`,
    r.interests?.length ? `Interests: ${r.interests.join(', ')}.` : '',
    r.diet ? `Diet: ${r.diet}.` : '',
    profileLines(profile),
    `Centre: ${t.center?.lat}, ${t.center?.lng}.`,
    `Forecast:\n${forecastLines(r, t.forecast) || 'n/a'}`,
    `Current plan:\n${planAsText(t)}`,
    `Other places Hive knows nearby (by ID):\n${shortlist(t.known)}`,
    'If they only ask a question, answer briefly (2-4 sentences) without tools.',
    'If they want a change, research with find_places, then call propose_plan with the WHOLE revised trip and a one-line "summary" of what changed. Keep everything they did not ask to change.',
    'If they tell you a lasting fact about themselves (diet, home city, interests), also call remember.',
    ...RULES,
    'After the plan passes, reply in 1-3 sentences explaining the change. The traveller will accept or reject it.',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- grounding + checks ----------

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function resolvePlace(name: string | undefined, known: Record<string, Place>): Place | null {
  if (!name) return null
  const all = Object.values(known)
  const id = /^\s*(P\d{1,4})\b/i.exec(name)?.[1]?.toUpperCase()
  if (id) {
    const byId = all.find((p) => p.id === id)
    if (byId) return byId
  }
  const n = norm(name)
  if (!n) return null
  return all.find((p) => norm(p.name) === n) ?? all.find((p) => norm(p.name).length > 3 && (n.includes(norm(p.name)) || norm(p.name).includes(n))) ?? null
}

/** A known place within 80 m of the given coordinates, if any. */
export function nearestKnown(lat: unknown, lng: unknown, known: Record<string, Place>): Place | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  let best: Place | null = null
  let bestKm = 0.08
  for (const p of Object.values(known)) {
    const km = haversineKm({ lat, lng }, p)
    if (km < bestKm) {
      best = p
      bestKm = km
    }
  }
  return best
}

function issue(date: string, severity: Issue['severity'], message: string, stopIds: string[] = []): Issue {
  return { date, type: 'unverified' as Issue['type'], severity, message, stopIds }
}

/** Hive's own checks on top of the Plan Doctor. */
export function requestChecks(req: TripRequest, stops: Stop[], weather: Record<string, DayWeather>, unresolved: Stop[] = []): Issue[] {
  const issues: Issue[] = []
  for (const s of unresolved) {
    issues.push(issue(s.date, 'error', `"${s.place ?? s.title}" is not on the shortlist. Set "place" to a shortlist ID like "P7".`, [s.id]))
  }
  const seen = new Map<string, string>()
  for (const s of stops) {
    const k = norm(s.place ?? s.title)
    if (seen.has(k)) issues.push(issue(s.date, 'error', `"${s.place ?? s.title}" is used twice (also on ${seen.get(k)}). Pick a different place.`, [s.id]))
    else seen.set(k, s.date)
  }
  if (/sunset/i.test(req.prompt)) {
    const near = stops.filter((s) => {
      const sunset = toMinutes(weather[s.date]?.sunset)
      const start = toMinutes(s.start)
      if (sunset == null || start == null) return false
      return /sunset|viewpoint|miradouro|view|lookout|park|beach|terrace|rooftop/i.test(`${s.title} ${s.place ?? ''} ${s.kind ?? ''}`) && start >= sunset - 75 && start <= sunset - 10
    })
    const day = Object.entries(weather).find(([d, w]) => d >= req.startDate && d <= req.endDate && w.sunset)
    if (!near.length && day) {
      issues.push(issue(day[0], 'error', `The traveller asked for sunset, but no viewpoint starts 10-75 min before sunset (sunset ${day[1].sunset}). Move one there.`))
    }
  }
  for (const [date, day] of groupByDate(stops)) {
    const food = sortDay(day.filter((s) => s.category === 'food'))
    if (food.length < 3) issues.push(issue(date, 'error', `Only ${food.length} meal stop(s) on ${date}. Every day needs breakfast, lunch and dinner.`))
    const dinner = food.at(-1)
    const dinnerAt = toMinutes(dinner?.start)
    if (food.length >= 3 && dinnerAt != null && dinnerAt < 18 * 60)
      issues.push(issue(date, 'error', `Dinner "${dinner!.title}" starts at ${dinner!.start}, too early. Move dinner to 18:30-21:00.`, [dinner!.id]))
  }
  return issues
}

function report(issues: Issue[]): string {
  if (!issues.length) return 'Plan Doctor: no issues. The plan is ready.'
  const errs = issues.filter((i) => i.severity === 'error')
  return (
    `Plan Doctor found ${errs.length} error(s) and ${issues.length - errs.length} warning(s):\n` +
    issues.map((i) => `- [${i.severity}] ${i.date} ${i.type}: ${i.message}`).join('\n') +
    (errs.length ? '\nFix every error and call propose_plan again.' : '\nNo errors: you may finish, or fix warnings if easy.')
  )
}

interface Draft {
  title?: string
  summary?: string
  stops: Stop[]
  stay?: Stay
  tips: string[]
  issues: Issue[]
}

function evaluate(raw: Record<string, unknown>, req: TripRequest, weather: Record<string, DayWeather>, known: Record<string, Place>): Draft {
  const list = Array.isArray(raw.stops) ? raw.stops : []
  const unresolved: Stop[] = []
  const stops: Stop[] = list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => {
      const stop: Stop = {
        id: randomUUID().slice(0, 8),
        date: String(s.date ?? ''),
        start: s.start ? String(s.start) : undefined,
        end: s.end ? String(s.end) : undefined,
        title: String(s.title ?? s.place ?? 'Untitled').slice(0, 120),
        place: s.place ? String(s.place) : undefined,
        category: s.category ? String(s.category) : undefined,
        costPerPerson: typeof s.costPerPerson === 'number' ? Math.max(0, s.costPerPerson) : undefined,
        outdoor: s.outdoor === true,
        note: s.note ? String(s.note).slice(0, 240) : undefined,
        tip: s.tip ? String(s.tip).slice(0, 240) : undefined,
      }
      // By name first; then by location (a translated name with the shortlist's coordinates).
      const hit = resolvePlace(stop.place ?? stop.title, known) ?? nearestKnown(s.lat, s.lng, known)
      if (hit) Object.assign(stop, { place: hit.name, lat: hit.lat, lng: hit.lng, address: hit.address, kind: hit.kind })
      else unresolved.push(stop)
      return stop
    })
  let stay: Stay | undefined
  const rs = raw.stay as Record<string, unknown> | undefined
  if (rs?.place) {
    const hit = resolvePlace(String(rs.place), known)
    if (hit) stay = { name: hit.name, lat: hit.lat, lng: hit.lng, area: hit.address, why: rs.why ? String(rs.why).slice(0, 240) : undefined, nightlyUsd: typeof rs.nightlyUsd === 'number' ? rs.nightlyUsd : undefined }
  }
  const prefs: PrefLike[] = [{ userId: 'me', pace: req.pace ?? 'balanced', dailyBudget: req.dailyBudget, wakeTime: req.wakeTime }]
  const issues = [
    ...checkPlan({ startDate: req.startDate, endDate: req.endDate, forecast: weather }, stops, prefs),
    ...requestChecks(req, stops, weather, unresolved),
  ]
  if (!stay) issues.push(issue(req.startDate, 'warn', rs?.place ? `Stay "${rs.place}" is not a hotel Hive found.` : 'No stay picked yet: find_places kind "hotel" and choose one.'))
  return {
    title: raw.title ? String(raw.title).slice(0, 80) : undefined,
    summary: raw.summary ? String(raw.summary).slice(0, 240) : undefined,
    stops,
    stay,
    tips: Array.isArray(raw.tips) ? raw.tips.map(String).slice(0, 6) : [],
    issues,
  }
}

// ---------- place ids ----------

/** Add a place to the known set, giving it a stable short id the model can use. */
export function remember(known: Record<string, Place>, p: Place): Place {
  const existing = known[p.name]
  if (existing) return existing
  p.id = `P${Object.keys(known).length + 1}`
  known[p.name] = p
  return p
}

/** Give ids to places saved before ids existed. */
export function ensureIds(known: Record<string, Place>) {
  const used = new Set(Object.values(known).map((p) => p.id).filter(Boolean))
  let n = 1
  for (const p of Object.values(known)) {
    if (p.id) continue
    while (used.has(`P${n}`)) n++
    p.id = `P${n}`
    used.add(p.id)
  }
}

// ---------- research (in code, not by the model) ----------

const INTEREST_SEARCH: Record<string, Array<[string, string?]>> = {
  food: [['restaurant']],
  coffee: [['cafe']],
  history: [['attraction'], ['museum']],
  culture: [['attraction'], ['museum']],
  art: [['gallery'], ['museum']],
  architecture: [['attraction']],
  nature: [['park']],
  views: [['viewpoint']],
  nightlife: [['bar']],
  music: [['bar']],
  markets: [['market']],
  shopping: [['market']],
}

/** The searches every trip needs, run in parallel so the model doesn't spend steps on them. */
export function researchPlan(r: TripRequest): Array<[string, string?]> {
  const wanted: Array<[string, string?]> = [['hotel'], ['restaurant'], ['cafe'], ['bakery'], ['attraction'], ['viewpoint'], ['museum'], ['park']]
  for (const i of r.interests ?? []) wanted.push(...(INTEREST_SEARCH[i] ?? []))
  if (r.diet) wanted.push(['restaurant', r.diet.split(/[ ,]/)[0]])
  const seen = new Set<string>()
  return wanted.filter(([k, kw]) => {
    const key = `${k}|${kw ?? ''}`
    return !seen.has(key) && seen.add(key)
  })
}

async function research(req: TripRequest, center: { lat: number; lng: number }, known: Record<string, Place>, f: typeof fetch, note: (step: number, tool: string, text: string) => void) {
  const searches = researchPlan(req)
  const found = await Promise.all(searches.map(([kind, kw]) => findPlaces(center.lat, center.lng, kind, 3000, f, kw ?? '').catch(() => [] as Place[])))
  searches.forEach(([kind, kw], i) => {
    for (const p of found[i]) remember(known, p)
    note(0, 'find_places', `${kind}${kw ? ` "${kw}"` : ''}: ${found[i].length} found`)
  })
}

function shortlist(known: Record<string, Place>): string {
  const byKind: Record<string, Place[]> = {}
  for (const p of Object.values(known)) (byKind[p.kind] ??= []).length < 12 && byKind[p.kind].push(p)
  return Object.entries(byKind)
    .map(([k, list]) => `${k}:\n${list.map((p) => `- ${p.id} · ${p.name} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`).join('\n')}`)
    .join('\n')
}

// ---------- the loop ----------

interface LoopResult {
  text: string
  draft?: Draft
}

async function loop(
  messages: ChatMessage[],
  tools: ToolSpec[],
  ctx: { req: TripRequest; weather: Record<string, DayWeather>; known: Record<string, Place>; mustPlan: boolean },
  deps: AgentDeps,
  note: (step: number, tool: string, text: string) => void,
): Promise<LoopResult> {
  const f = deps.fetch ?? fetch
  const maxSteps = deps.maxSteps ?? 16
  const researchBudget = deps.researchBudget ?? 3
  const planOnly = tools.filter((t) => t.function.name === 'propose_plan')
  let draft: Draft | undefined
  let best: Draft | undefined
  let nudges = 0
  let searches = 0
  let forced = false
  for (let step = 1; step <= maxSteps; step++) {
    // Out of research budget (or steps) with no draft yet: only propose_plan is allowed.
    const mustDraftNow = ctx.mustPlan && !draft && (searches >= researchBudget || step >= maxSteps - 2)
    if (mustDraftNow && !forced) {
      forced = true
      messages.push({ role: 'user', content: 'Research is done. Call propose_plan now with the WHOLE trip, using only places from the shortlist and your searches.' })
    }
    const clean = !!draft && !draft.issues.some((i) => i.severity === 'error')
    // Clean draft: no tools, just the summary. Draft with errors and no search budget left: redraft only.
    const offer = clean ? [] : mustDraftNow || (draft && searches >= researchBudget) ? planOnly : tools
    const reply = await deps.llm(messages, offer)
    // Ignore calls to tools that weren't offered this step.
    const allowed = new Set(offer.map((t) => t.function.name))
    if (reply.tool_calls) reply.tool_calls = reply.tool_calls.filter((c) => allowed.has(c.function.name))
    messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls?.length ? reply.tool_calls : undefined })
    if (!reply.tool_calls?.length) {
      const clean = draft && !draft.issues.some((i) => i.severity === 'error')
      if (clean || (!ctx.mustPlan && !draft) || nudges >= 2) return { text: (reply.content ?? '').trim(), draft: clean ? draft : (best ?? draft) }
      nudges++
      messages.push({ role: 'user', content: draft ? 'The plan still has errors. Fix them and call propose_plan again.' : 'Call propose_plan with the whole trip.' })
      continue
    }
    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        /* answered below */
      }
      let result: unknown
      try {
        switch (call.function.name) {
          case 'geocode': {
            const p = await geocode(String(args.query ?? ''), f)
            if (p) remember(ctx.known, p)
            note(step, 'geocode', String(args.query))
            result = p ?? 'Not found.'
            break
          }
          case 'find_places': {
            searches++
            if (searches > researchBudget + 2) {
              result = 'Search limit reached. Use the shortlist and call propose_plan.'
              break
            }
            const found = await findPlaces(Number(args.lat), Number(args.lng), String(args.kind), Number(args.radius_m) || 2500, f, String(args.keyword ?? ''))
            for (const p of found) remember(ctx.known, p)
            note(step, 'find_places', `${args.kind}${args.keyword ? ` "${args.keyword}"` : ''}: ${found.length} found`)
            result = found.length ? found.map((p) => ({ id: ctx.known[p.name]?.id, name: p.name, lat: p.lat, lng: p.lng, address: p.address })) : 'No places found. Try another kind, keyword or a wider radius. Do not invent places.'
            break
          }
          case 'propose_plan': {
            draft = evaluate(args, ctx.req, ctx.weather, ctx.known)
            const errs = draft.issues.filter((i) => i.severity === 'error').length
            if (!best || errs < best.issues.filter((i) => i.severity === 'error').length) best = draft
            const firstErr = draft.issues.find((i) => i.severity === 'error')?.message
            note(step, 'propose_plan', `${draft.stops.length} stops · ${errs} error(s), ${draft.issues.length - errs} warning(s)${firstErr ? ` · fixing: ${firstErr.slice(0, 90)}` : ''}`)
            result = report(draft.issues)
            break
          }
          case 'remember': {
            const patch: Profile = {}
            if (args.homeCity) patch.homeCity = String(args.homeCity).slice(0, 80)
            if (args.diet) patch.diet = String(args.diet).slice(0, 80)
            if (Array.isArray(args.interests)) patch.interests = args.interests.map(String).slice(0, 8)
            if (args.pace) patch.pace = String(args.pace)
            if (typeof args.dailyBudget === 'number') patch.dailyBudget = args.dailyBudget
            if (args.note) patch.notes = [String(args.note).slice(0, 160)]
            await deps.remember?.(patch)
            note(step, 'remember', Object.entries(patch).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; '))
            result = 'Saved.'
            break
          }
          default:
            result = { error: `Unknown tool ${call.function.name}` }
        }
      } catch (err) {
        result = { error: (err as Error).message }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: typeof result === 'string' ? result : JSON.stringify(result) })
    }
  }
  return { text: '', draft: draft && !draft.issues.some((i) => i.severity === 'error') ? draft : (best ?? draft) }
}

function noteFn(deps: AgentDeps, log: Trip['log']) {
  return (step: number, tool: string, text: string) => {
    const e = { step, tool, note: text }
    log.push(e)
    deps.onStep?.(e)
  }
}

/** Plan a new trip. Returns the core trip; the server enriches it (legs, money, budget, ideas). */
export async function runHive(req: TripRequest, deps: AgentDeps): Promise<Trip> {
  const f = deps.fetch ?? fetch
  const log: Trip['log'] = []
  const note = noteFn(deps, log)
  const center = await geocode(req.destination, f).catch(() => null)
  const weather = center ? await forecast(center.lat, center.lng, f).catch(() => ({})) : {}
  note(0, 'setup', center ? `Found ${center.name} (${center.lat.toFixed(3)}, ${center.lng.toFixed(3)})` : 'Destination not geocoded')
  const known: Record<string, Place> = {}
  if (center) await research(req, center, known, f, note)
  const messages: ChatMessage[] = [
    { role: 'system', content: planPrompt(req, weather, deps.profile) },
    {
      role: 'user',
      content: `${req.prompt}${center ? `\n(Destination centre: ${center.lat}, ${center.lng})` : ''}\n\nHive already searched OpenStreetMap. Shortlist of real places (refer to them by ID, e.g. "place": "P4"):\n${shortlist(known)}\n\nUse find_places only for something specific that is missing (at most 3 searches), then call propose_plan.`,
    },
  ]
  const { text, draft } = await loop(messages, TOOLS, { req, weather, known, mustPlan: true }, deps, note)
  const now = new Date().toISOString()
  const trip: Trip = {
    id: randomUUID().slice(0, 8),
    createdAt: now,
    updatedAt: now,
    request: req,
    center: center ? { lat: center.lat, lng: center.lng, name: center.name, address: center.address } : undefined,
    stops: draft?.stops ?? [],
    stay: draft?.stay,
    tips: draft?.tips ?? [],
    issues: draft?.issues ?? [],
    forecast: weather,
    forecastCheckedAt: now,
    summary: text || (draft ? 'Here is the best plan Hive reached.' : 'Hive could not finish a plan this time.'),
    title: draft?.title || `${center?.name ?? req.destination} trip`,
    legs: [],
    ideas: {},
    rainyBackups: [],
    known,
    log,
    chat: [],
    proposals: [],
  }
  if (req.slackChannel && trip.stops.length) {
    const post = deps.slack ?? slackPost
    const r = await post(req.slackChannel, formatForSlack(trip))
    trip.shared = { channel: req.slackChannel, ...r }
    note(99, 'slack', r.ok ? `Posted to ${req.slackChannel}` : `Slack failed: ${r.error}`)
  }
  return trip
}

function diffPlans(before: Stop[], after: Stop[]): Proposal['diff'] {
  const key = (s: Stop) => norm(s.place ?? s.title)
  const b = new Map(before.map((s) => [key(s), s]))
  const a = new Map(after.map((s) => [key(s), s]))
  const added = [...a.keys()].filter((k) => !b.has(k)).map((k) => `${a.get(k)!.date} ${a.get(k)!.start} ${a.get(k)!.title}`)
  const removed = [...b.keys()].filter((k) => !a.has(k)).map((k) => `${b.get(k)!.date} ${b.get(k)!.start} ${b.get(k)!.title}`)
  const moved = [...a.keys()]
    .filter((k) => b.has(k) && (b.get(k)!.date !== a.get(k)!.date || b.get(k)!.start !== a.get(k)!.start))
    .map((k) => `${a.get(k)!.title}: ${b.get(k)!.date} ${b.get(k)!.start} → ${a.get(k)!.date} ${a.get(k)!.start}`)
  return { added, removed, moved }
}

/** Chat about a trip. May return a proposal (never applied here). */
export async function reviseTrip(trip: Trip, message: string, deps: AgentDeps): Promise<{ reply: string; proposal?: Proposal }> {
  const note = noteFn(deps, [])
  ensureIds(trip.known)
  const known = { ...trip.known }
  const history: ChatMessage[] = trip.chat.slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
  const messages: ChatMessage[] = [{ role: 'system', content: revisePrompt(trip, deps.profile) }, ...history, { role: 'user', content: message }]
  const { text, draft } = await loop(messages, [...TOOLS, REMEMBER], { req: trip.request, weather: trip.forecast, known, mustPlan: false }, deps, note)
  Object.assign(trip.known, known)
  if (!draft || !draft.stops.length) return { reply: text || 'Done.' }
  const errs = draft.issues.filter((i) => i.severity === 'error')
  if (errs.length) return { reply: `${text}\n\n(I couldn't get that change past the Plan Doctor: ${errs[0].message})`.trim() }
  const proposal: Proposal = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    ask: message.slice(0, 300),
    summary: draft.summary || text.split('\n')[0] || 'Revised plan',
    stops: draft.stops,
    stay: draft.stay,
    diff: diffPlans(trip.stops, draft.stops),
    status: 'open',
  }
  return { reply: text || proposal.summary, proposal }
}

export function formatForSlack(t: Trip): string {
  const lines = [`*${t.title}* · ${t.request.destination} (${t.request.startDate} to ${t.request.endDate})`, t.summary, '']
  if (t.stay) lines.push(`🏨 ${t.stay.name}`, '')
  for (const [date, stops] of [...groupByDate(t.stops).entries()].sort()) {
    const w = t.forecast[date]
    lines.push(`*${date}*${w ? ` · ${w.desc}, ${w.min}-${w.max}°C` : ''}`)
    for (const s of sortDay(stops)) lines.push(`• ${s.start ?? '--:--'} ${s.title}`)
  }
  return lines.join('\n')
}

/** Re-run every check on a saved trip (used after accepting a proposal or refreshing the forecast). */
export function checkTrip(trip: Trip): Issue[] {
  const r = trip.request
  const prefs: PrefLike[] = [{ userId: 'me', pace: r.pace ?? 'balanced', dailyBudget: r.dailyBudget, wakeTime: r.wakeTime }]
  return [...checkPlan({ startDate: r.startDate, endDate: r.endDate, forecast: trip.forecast }, trip.stops, prefs), ...requestChecks(r, trip.stops, trip.forecast)]
}
