/**
 * Hive: a personal trip agent.
 *
 * Loop: the model researches with tools, drafts an itinerary with
 * `propose_plan`, and gets back the deterministic Plan Doctor report
 * (reused from TripHive's planCheck). It keeps revising until the plan has
 * no errors, then writes a short summary. Optionally shares to Slack.
 */
import { randomUUID } from 'node:crypto'
import { checkPlan, groupByDate, toMinutes, type Issue, type PrefLike, type StopLike } from './lib/planCheck.ts'
import { slackPost, type ChatMessage, type Llm, type ToolSpec } from './connectors.ts'
import { findPlaces, forecast, geocode, type DayWeather } from './world.ts'

export interface TripRequest {
  prompt: string
  destination: string
  startDate: string
  endDate: string
  pace?: 'chill' | 'balanced' | 'packed'
  dailyBudget?: number
  wakeTime?: string
  slackChannel?: string
}

export interface TripResult {
  id: string
  createdAt: string
  request: TripRequest
  stops: StopLike[]
  issues: Issue[]
  forecast: Record<string, DayWeather>
  summary: string
  log: Array<{ step: number; tool: string; note: string }>
  shared?: { channel: string; ok: boolean; error?: string }
}

export interface AgentDeps {
  llm: Llm
  fetch?: typeof fetch
  slack?: typeof slackPost
  maxSteps?: number
  onStep?: (entry: { step: number; tool: string; note: string }) => void
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
      description: 'List real named places near a point from OpenStreetMap.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          kind: { type: 'string', enum: ['restaurant', 'cafe', 'museum', 'attraction', 'viewpoint', 'park', 'bar', 'market'] },
          radius_m: { type: 'number' },
          keyword: { type: 'string', description: 'Optional, e.g. "seafood", "pastry", "miradouro"' },
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
        'Submit the full itinerary. Returns the Plan Doctor report (overlaps, tight travel, missing meals, rain on outdoor stops, budget, early starts). Fix every error and resubmit.',
      parameters: {
        type: 'object',
        properties: {
          stops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                start: { type: 'string', description: 'HH:MM' },
                end: { type: 'string', description: 'HH:MM' },
                title: { type: 'string' },
                category: { type: 'string', description: 'food, sight, activity, transit, lodging' },
                lat: { type: 'number' },
                lng: { type: 'number' },
                costPerPerson: { type: 'number' },
                outdoor: { type: 'boolean' },
              },
              required: ['date', 'start', 'end', 'title', 'category', 'lat', 'lng'],
            },
          },
        },
        required: ['stops'],
      },
    },
  },
]

function systemPrompt(r: TripRequest, weather: Record<string, DayWeather>): string {
  const wx = Object.entries(weather)
    .filter(([d]) => d >= r.startDate && d <= r.endDate)
    .map(([d, w]) => `${d}: ${w.desc}, ${w.min}-${w.max}°C${w.rain ? ', likely rain' : ''}${w.sunset ? `, sunset ${w.sunset}` : ''}`)
    .join('\n')
  return [
    'You are Hive, a trip-planning agent running on a Fly.io Sprite.',
    `Plan ${r.destination} from ${r.startDate} to ${r.endDate}.`,
    `Pace: ${r.pace ?? 'balanced'}. Daily budget per person: ${r.dailyBudget ? `$${r.dailyBudget}` : 'not set'}. Wake time: ${r.wakeTime ?? '08:00'}.`,
    wx ? `Forecast:\n${wx}` : 'No forecast available for these dates.',
    'Research first: call find_places several times (food, sights, viewpoints, parks) before proposing anything.',
    'Rules: every stop title must be the real name of a place returned by find_places or geocode (e.g. "Lunch at Cervejaria Ramiro"), with its coordinates.',
    'Never use generic titles like "breakfast" or "walk around", and never repeat a place across the trip.',
    'Every day needs breakfast, lunch and dinner at real restaurants or cafes. Leave travel time between stops. Put outdoor stops on dry days.',
    'Honour every specific request in the traveller\'s note. "At sunset" means the stop starts about 30 minutes before that day\'s sunset time.',
    'Call propose_plan with the whole itinerary, read the Plan Doctor report, fix every error and resubmit.',
    'When the report has no errors, reply with a short, friendly summary (no tool call).',
  ].join('\n')
}

function asStops(raw: unknown): StopLike[] {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      id: randomUUID().slice(0, 8),
      date: String(s.date ?? ''),
      start: s.start ? String(s.start) : undefined,
      end: s.end ? String(s.end) : undefined,
      title: String(s.title ?? 'Untitled'),
      category: s.category ? String(s.category) : undefined,
      lat: typeof s.lat === 'number' ? s.lat : undefined,
      lng: typeof s.lng === 'number' ? s.lng : undefined,
      costPerPerson: typeof s.costPerPerson === 'number' ? s.costPerPerson : undefined,
      outdoor: s.outdoor === true,
    }))
}

/**
 * Hive's own checks on top of the Plan Doctor: requests from the traveller's
 * note that a model tends to forget. Currently: "at sunset".
 */
export function requestChecks(req: TripRequest, stops: StopLike[], weather: Record<string, DayWeather>): Issue[] {
  const issues: Issue[] = []
  if (/sunset/i.test(req.prompt)) {
    const near = stops.filter((s) => {
      const sunset = toMinutes(weather[s.date]?.sunset)
      const start = toMinutes(s.start)
      if (sunset == null || start == null) return false
      return /sunset|viewpoint|miradouro|view/i.test(`${s.title} ${s.category ?? ''}`) && start >= sunset - 75 && start <= sunset - 10
    })
    if (!near.length) {
      const day = Object.entries(weather).find(([d, w]) => d >= req.startDate && d <= req.endDate && w.sunset)
      issues.push({
        date: day?.[0] ?? req.startDate,
        type: 'early-start',
        severity: 'error',
        message: `The traveller asked for a sunset stop, but no viewpoint starts 10-75 minutes before sunset${day ? ` (sunset ${day[1].sunset})` : ''}. Move one there.`,
        stopIds: [],
      })
    }
  }
  return issues
}

function report(issues: Issue[]): string {
  if (!issues.length) return 'Plan Doctor: no issues. The plan is ready.'
  return (
    `Plan Doctor found ${issues.length} issue(s):\n` +
    issues.map((i) => `- [${i.severity}] ${i.date} ${i.type}: ${i.message}`).join('\n')
  )
}

export function formatForSlack(t: TripResult): string {
  const days = groupByDate(t.stops)
  const lines = [`*Hive plan: ${t.request.destination}* (${t.request.startDate} to ${t.request.endDate})`, t.summary, '']
  for (const [date, stops] of [...days.entries()].sort()) {
    const w = t.forecast[date]
    lines.push(`*${date}*${w ? ` · ${w.desc}, ${w.min}-${w.max}°C` : ''}`)
    for (const s of stops) lines.push(`• ${s.start ?? '--:--'} ${s.title}`)
  }
  const warns = t.issues.filter((i) => i.severity === 'warn')
  if (warns.length) lines.push('', `_${warns.length} heads-up(s): ${warns.map((w) => w.message).join('; ')}_`)
  return lines.join('\n')
}

export async function runHive(req: TripRequest, deps: AgentDeps): Promise<TripResult> {
  const f = deps.fetch ?? fetch
  const maxSteps = deps.maxSteps ?? 14
  const log: TripResult['log'] = []
  const note = (step: number, tool: string, text: string) => {
    const e = { step, tool, note: text }
    log.push(e)
    deps.onStep?.(e)
  }

  const center = await geocode(req.destination, f).catch(() => null)
  const weather = center ? await forecast(center.lat, center.lng, f).catch(() => ({})) : {}
  note(0, 'setup', center ? `Found ${center.name} (${center.lat.toFixed(3)}, ${center.lng.toFixed(3)})` : 'Destination not geocoded')

  const prefs: PrefLike[] = [{ userId: 'me', pace: req.pace ?? 'balanced', dailyBudget: req.dailyBudget, wakeTime: req.wakeTime }]
  const trip = { startDate: req.startDate, endDate: req.endDate, forecast: weather }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(req, weather) },
    {
      role: 'user',
      content: `${req.prompt}${center ? `\n(Destination centre: ${center.lat}, ${center.lng})` : ''}`,
    },
  ]

  let stops: StopLike[] = []
  let issues: Issue[] = []
  let summary = ''

  for (let step = 1; step <= maxSteps; step++) {
    const reply = await deps.llm(messages, TOOLS)
    messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls })

    if (!reply.tool_calls?.length) {
      if (stops.length && !issues.some((i) => i.severity === 'error')) {
        summary = (reply.content ?? '').trim()
        break
      }
      messages.push({
        role: 'user',
        content: stops.length ? 'The plan still has errors. Fix them and call propose_plan again.' : 'Call propose_plan with the itinerary.',
      })
      continue
    }

    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        /* bad JSON: answer with an error below */
      }
      let result: unknown
      try {
        switch (call.function.name) {
          case 'geocode': {
            result = await geocode(String(args.query ?? ''), f)
            note(step, 'geocode', String(args.query))
            break
          }
          case 'find_places': {
            const found = await findPlaces(Number(args.lat), Number(args.lng), String(args.kind), Number(args.radius_m) || 2500, f, String(args.keyword ?? ''))
            note(step, 'find_places', `${args.kind}${args.keyword ? ` "${args.keyword}"` : ''}: ${found.length} found`)
            result = found.length ? found : 'No places found. Try another kind, keyword or a wider radius. Do not invent places.'
            break
          }
          case 'propose_plan': {
            stops = asStops(args.stops)
            issues = [...checkPlan(trip, stops, prefs), ...requestChecks(req, stops, weather)]
            const errs = issues.filter((i) => i.severity === 'error').length
            note(step, 'propose_plan', `${stops.length} stops · ${errs} error(s), ${issues.length - errs} warning(s)`)
            result = report(issues)
            break
          }
          default:
            result = { error: `Unknown tool ${call.function.name}` }
        }
      } catch (err) {
        result = { error: (err as Error).message }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      })
    }
  }

  if (!summary) {
    summary = stops.length
      ? `Here is the best plan Hive reached in ${maxSteps} steps.`
      : 'Hive could not finish a plan this time.'
  }

  const result: TripResult = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    request: req,
    stops,
    issues,
    forecast: weather,
    summary,
    log,
  }

  if (req.slackChannel && stops.length) {
    const post = deps.slack ?? slackPost
    const r = await post(req.slackChannel, formatForSlack(result))
    result.shared = { channel: req.slackChannel, ...r }
    note(maxSteps + 1, 'slack', r.ok ? `Posted to ${req.slackChannel}` : `Slack failed: ${r.error}`)
  }
  return result
}
