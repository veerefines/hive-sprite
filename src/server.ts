/**
 * Hive's HTTP front door. Runs as a Sprite service on port 8080.
 * Trips and the traveller profile are JSON files on the Sprite's persistent disk.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayLlm, modelChain, slackPost, type Llm } from './connectors.ts'
import { configFromEnv, Limiter, politeFetch, QuotaError, useHttpCache } from './limits.ts'
import { photoForDestination } from './photos.ts'
import { checkTrip, formatForSlack, reviseTrip, runHive, type Profile } from './agent.ts'
import { computeBudget, computeIdeas, computeLegs, computeMoney, computePacking, computePhotos, toIcs, type Router } from './enrich.ts'
import { routeBetween } from './lib/routing.ts'
import { countryFor } from './lib/money.ts'
import { forecast, geocode } from './world.ts'
import type { Trip, TripRequest } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = process.env.HIVE_PUBLIC_DIR ?? join(HERE, '..', 'public')
const DATA = process.env.HIVE_DATA_DIR ?? join(HERE, '..', 'data')
const PORT = Number(process.env.PORT ?? 8080)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const INTERESTS = ['food', 'culture', 'history', 'art', 'nature', 'nightlife', 'shopping', 'architecture', 'coffee', 'markets', 'views', 'music']

const MAX_BODY_BYTES = 64_000

class RequestBodyError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let oversized = false
  for await (const c of req) {
    const chunk = c as Buffer
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      oversized = true
      continue
    }
    if (!oversized) chunks.push(chunk)
  }
  if (oversized) throw new RequestBodyError('Request too large', 413)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new RequestBodyError('Invalid JSON request body', 400)
  }
}

function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function validate(raw: unknown): TripRequest | string {
  const r = (raw ?? {}) as Record<string, unknown>
  const destination = String(r.destination ?? '').trim().slice(0, 120)
  const startDate = String(r.startDate ?? '')
  const endDate = String(r.endDate ?? '')
  if (!destination) return 'destination is required'
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) return 'dates must be valid YYYY-MM-DD calendar dates'
  if (endDate < startDate) return 'endDate is before startDate'
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1
  if (days > 5) return 'Hive plans up to 5 days at a time'
  const pace = ['chill', 'balanced', 'packed'].includes(String(r.pace)) ? (r.pace as TripRequest['pace']) : 'balanced'
  const channel = String(r.slackChannel ?? '').trim()
  const interests = (Array.isArray(r.interests) ? r.interests : String(r.interests ?? '').split(','))
    .map((x) => String(x).trim().toLowerCase())
    .filter((x) => INTERESTS.includes(x))
  return {
    destination,
    startDate,
    endDate,
    pace,
    prompt: String(r.prompt ?? '').slice(0, 1000) || `Plan a great ${days}-day trip to ${destination}.`,
    dailyBudget: Number(r.dailyBudget) > 0 ? Math.min(5000, Number(r.dailyBudget)) : undefined,
    wakeTime: /^\d{2}:\d{2}$/.test(String(r.wakeTime)) ? String(r.wakeTime) : undefined,
    travellers: Math.min(12, Math.max(1, Math.round(Number(r.travellers) || 1))),
    origin: String(r.origin ?? '').trim().slice(0, 120) || undefined,
    interests: [...new Set(interests)],
    diet: String(r.diet ?? '').trim().slice(0, 80) || undefined,
    slackChannel: /^[#@]?[\w-]{1,80}$/.test(channel) ? channel : undefined,
  }
}

// ---------- storage ----------

const tripPath = (id: string) => join(DATA, 'trips', `${id}.json`)

async function saveTrip(t: Trip) {
  t.updatedAt = new Date().toISOString()
  await mkdir(join(DATA, 'trips'), { recursive: true })
  const tmp = `${tripPath(t.id)}.tmp`
  await writeFile(tmp, JSON.stringify(t))
  await rename(tmp, tripPath(t.id))
}

/** Fill fields that older trip files (v1) don't have. */
export function normalizeTrip(t: Partial<Trip> & { id: string; request: TripRequest }): Trip {
  const n = t as Trip
  n.createdAt ??= new Date().toISOString()
  n.updatedAt ??= n.createdAt
  n.stops ??= []
  n.issues ??= []
  n.forecast ??= {}
  n.tips ??= []
  n.legs ??= []
  n.ideas ??= {}
  n.rainyBackups ??= []
  n.known ??= {}
  n.log ??= []
  n.chat ??= []
  n.proposals ??= []
  n.summary ??= ''
  n.title ??= `${n.request.destination.split(',')[0]} trip`

  // Sanitize leaked tool markup from old trips (2026-11-28 fix)
  if (n.summary && (/<tool_call|<function=|<parameter=|>\s*(propose_plan|find_places|remember|geocode)\s*>/.test(n.summary))) {
    n.summary = ''
  }
  return n
}

async function loadTrip(id: string): Promise<Trip | null> {
  if (!/^[\w-]{1,40}$/.test(id)) return null
  const raw = await readFile(tripPath(id), 'utf8').catch(() => null)
  return raw ? normalizeTrip(JSON.parse(raw)) : null
}

async function listTrips() {
  const dir = join(DATA, 'trips')
  const files = await readdir(dir).catch(() => [] as string[])
  const trips = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readFile(join(dir, f), 'utf8').then((x) => normalizeTrip(JSON.parse(x))).catch(() => null)))
  return trips
    .filter((t): t is Trip => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      destination: t.center?.name ?? t.request.destination,
      startDate: t.request.startDate,
      endDate: t.request.endDate,
      stops: t.stops.length,
      totalUsd: t.budget?.totalUsd,
      cover: t.cover ?? null,
    }))
}

const profilePath = () => join(DATA, 'profile.json')
export async function loadProfile(): Promise<Profile> {
  return JSON.parse((await readFile(profilePath(), 'utf8').catch(() => '{}')) || '{}') as Profile
}
export async function mergeProfile(patch: Profile): Promise<Profile> {
  const cur = await loadProfile()
  const next: Profile = { ...cur, ...patch, notes: [...(cur.notes ?? []), ...(patch.notes ?? [])].slice(-10) }
  if (patch.interests) next.interests = [...new Set([...(cur.interests ?? []), ...patch.interests])].slice(0, 12)
  await mkdir(DATA, { recursive: true })
  await writeFile(profilePath(), JSON.stringify(next, null, 2))
  return next
}

// ---------- enrichment ----------

export async function enrich(trip: Trip, route: Router = routeBetween, f: typeof fetch = fetch): Promise<Trip> {
  if (trip.request.origin && trip.originPoint === undefined) {
    const o = await geocode(trip.request.origin, f).catch(() => null)
    trip.originPoint = o ? { lat: o.lat, lng: o.lng } : null
  }
  trip.money = await computeMoney(trip, f)
  const index = countryFor(trip.center?.address ?? trip.request.destination)?.index ?? 1
  trip.legs = await computeLegs(trip, route, index)
  trip.budget = computeBudget(trip, trip.originPoint ?? null)
  const prevIdeas = new Map([...trip.rainyBackups ?? [], ...Object.values(trip.ideas ?? {}).flat()].map((p) => [p.name, p.photo]))
  Object.assign(trip, computeIdeas(trip))
  for (const p of [...trip.rainyBackups, ...Object.values(trip.ideas).flat()]) if (prevIdeas.has(p.name)) p.photo = prevIdeas.get(p.name)
  await computePhotos(trip, f).catch(() => {})
  trip.packing = computePacking(trip, trip.packing)
  return trip
}

// ---------- guardrails ----------

/**
 * The visitor's IP. Fly's Sprite proxy appends the client address and then
 * two hops of its own to X-Forwarded-For, so we count from the right:
 * anything further left was sent by the client and can't be trusted.
 */
export function clientIp(req: IncomingMessage, hops = Number(process.env.HIVE_PROXY_HOPS ?? 2)): string {
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const ip = chain.length > hops ? chain[chain.length - 1 - hops] : chain.length ? chain[0] : req.socket.remoteAddress
  return (ip || 'unknown').slice(0, 64)
}

/** Per-visitor request cap on the API: a token bucket, 90 requests a minute. */
const buckets = new Map<string, { tokens: number; at: number }>()
export function allowRequest(ip: string, now = Date.now(), rate = 90): boolean {
  const b = buckets.get(ip) ?? { tokens: rate, at: now }
  b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate)
  b.at = now
  if (buckets.size > 5000) buckets.clear()
  buckets.set(ip, b)
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

function quota(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof QuotaError)) return false
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(err.retryAfterSec) })
  res.end(JSON.stringify({ error: err.message, retryAfterSec: err.retryAfterSec }))
  return true
}

// ---------- server ----------

const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' }
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' }

let running = 0
const busyTrips = new Set<string>()

function ndjson(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  return (obj: unknown) => res.write(JSON.stringify(obj) + '\n')
}

export function makeServer(
  llmFactory?: () => Llm,
  route: Router = routeBetween,
  f: typeof fetch = politeFetch(),
  limiter: Limiter = new Limiter(configFromEnv(), join(DATA, 'limits.json')),
) {
  const makeLlm = llmFactory ?? (() => gatewayLlm(undefined, undefined, fetch, undefined, () => limiter.llmCall()))
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const p = url.pathname
    const ip = clientIp(req)
    try {
      if (p.startsWith('/api/') && !allowRequest(ip)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
        return res.end(JSON.stringify({ error: 'Too many requests. Slow down a little.' }))
      }
      const file = STATIC[p] ?? (/^\/t\/[\w-]{1,40}$/.test(p) ? 'index.html' : undefined)
      if (req.method === 'GET' && file) {
        const content = await readFile(join(PUBLIC, file))
        res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()!], 'cache-control': 'no-cache' })
        return res.end(content)
      }
      if (req.method === 'GET' && p === '/api/health') {
        return json(res, 200, {
          ok: true,
          llmConnector: !!(process.env.HIVE_LLM_GATEWAY || process.env.OPENROUTER_API_KEY),
          slackConnector: !!process.env.HIVE_SLACK_GATEWAY,
          models: modelChain(),
          host: process.env.SPRITE_NAME ?? 'local',
          ...limiter.status(ip),
        })
      }
      if (p === '/api/profile') {
        if (req.method === 'GET') return json(res, 200, await loadProfile())
        if (req.method === 'PUT') {
          const b = (await body(req)) as Record<string, unknown>
          const clean: Profile = {
            homeCity: b.homeCity ? String(b.homeCity).slice(0, 80) : undefined,
            diet: b.diet ? String(b.diet).slice(0, 80) : undefined,
            interests: Array.isArray(b.interests) ? b.interests.map(String).filter((x) => INTERESTS.includes(x)) : undefined,
            pace: ['chill', 'balanced', 'packed'].includes(String(b.pace)) ? String(b.pace) : undefined,
            dailyBudget: Number(b.dailyBudget) > 0 ? Number(b.dailyBudget) : undefined,
          }
          await mkdir(DATA, { recursive: true })
          const cur = await loadProfile()
          const next = { ...clean, notes: cur.notes }
          await writeFile(profilePath(), JSON.stringify(next, null, 2))
          return json(res, 200, next)
        }
      }
      if (req.method === 'GET' && p === '/api/trips') return json(res, 200, await listTrips())
      if (req.method === 'GET' && p === '/api/whoami') {
        const h = req.headers
        return json(res, 200, { ip, hops: String(h['x-forwarded-for'] ?? '').split(',').length })
      }
      if (req.method === 'GET' && p === '/api/cover') {
        const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 80)
        if (!q) return json(res, 400, { error: 'q required' })
        res.setHeader('cache-control', 'public, max-age=3600')
        return json(res, 200, (await photoForDestination(q, f)) ?? {})
      }

      const m = /^\/api\/trips\/([\w-]{1,40})(?:\/(chat|recheck|share|packing|calendar\.ics|proposals\/([\w-]{1,40})\/(accept|reject)))?$/.exec(p)
      if (m) {
        const [, id, action, pid, verdict] = m
        const trip = await loadTrip(id)
        if (!trip) return json(res, 404, { error: 'Trip not found' })

        if (req.method === 'GET' && !action) return json(res, 200, trip)

        if (req.method === 'GET' && action === 'calendar.ics') {
          res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="hive-${trip.id}.ics"` })
          return res.end(toIcs(trip))
        }

        if (req.method === 'POST' && action === 'share') {
          const { channel } = (await body(req)) as { channel?: string }
          if (!channel || !/^[#@]?[\w-]{1,80}$/.test(channel)) return json(res, 400, { error: 'channel required' })
          const r = await slackPost(channel, formatForSlack(trip))
          trip.shared = { channel, ...r }
          await saveTrip(trip)
          return json(res, r.ok ? 200 : 502, trip.shared)
        }

        if (req.method === 'POST' && action === 'packing') {
          const { id: itemId } = (await body(req)) as { id?: string }
          const item = trip.packing?.find((x) => x.id === itemId)
          if (!item) return json(res, 404, { error: 'item not found' })
          item.done = !item.done
          await saveTrip(trip)
          return json(res, 200, { packing: trip.packing })
        }

        if (req.method === 'POST' && action === 'recheck') {
          const before = new Set(trip.issues.map((i) => i.message))
          if (trip.center) trip.forecast = await forecast(trip.center.lat, trip.center.lng, f).catch(() => trip.forecast)
          trip.forecastCheckedAt = new Date().toISOString()
          trip.issues = checkTrip(trip)
          await enrich(trip, route, f)
          await saveTrip(trip)
          const fresh = trip.issues.filter((i) => !before.has(i.message))
          return json(res, 200, { trip, newIssues: fresh })
        }

        if (req.method === 'POST' && pid && verdict) {
          const prop = trip.proposals.find((x) => x.id === pid)
          if (!prop) return json(res, 404, { error: 'Proposal not found' })
          if (prop.status !== 'open') return json(res, 409, { error: `Proposal already ${prop.status}` })
          if (verdict === 'reject') {
            prop.status = 'rejected'
          } else {
            const newest = trip.proposals.filter((x) => x.status === 'open').at(-1)
            if (newest && newest.id !== prop.id) {
              prop.status = 'stale'
              await saveTrip(trip)
              return json(res, 409, { error: 'A newer suggestion replaced this one.', trip })
            }
            prop.status = 'accepted'
            trip.stops = prop.stops
            if (prop.stay) trip.stay = prop.stay
            trip.issues = checkTrip(trip)
            await enrich(trip, route, f)
          }
          trip.chat.push({ role: 'hive', text: verdict === 'accept' ? `Done. "${prop.summary}" is now in your plan.` : 'No problem, I kept the plan as it was.', at: new Date().toISOString() })
          await saveTrip(trip)
          return json(res, 200, trip)
        }

        if (req.method === 'POST' && action === 'chat') {
          const { message } = (await body(req)) as { message?: string }
          const text = String(message ?? '').trim().slice(0, 600)
          if (!text) return json(res, 400, { error: 'message required' })
          if (busyTrips.has(trip.id)) return json(res, 429, { error: 'Hive is still working on this trip.' })
          try {
            limiter.take('chat', ip)
          } catch (err) {
            if (quota(res, err)) return
            throw err
          }
          busyTrips.add(trip.id)
          const send = ndjson(res)
          try {
            for (const prop of trip.proposals) if (prop.status === 'open') prop.status = 'stale'
            const profile = await loadProfile()
            const { reply, proposal } = await reviseTrip(trip, text, {
              llm: makeLlm(),
              fetch: f,
              profile,
              maxSteps: 6,
              remember: async (patch) => void (await mergeProfile(patch)),
              onStep: (e) => send({ type: 'step', ...e }),
            })
            const at = new Date().toISOString()
            trip.chat.push({ role: 'user', text, at })
            if (proposal) trip.proposals.push(proposal)
            trip.chat.push({ role: 'hive', text: reply, at: new Date().toISOString(), proposalId: proposal?.id })
            trip.chat = trip.chat.slice(-60)
            trip.proposals = trip.proposals.slice(-20)
            await saveTrip(trip)
            send({ type: 'done', trip })
          } catch (err) {
            send({ type: 'error', error: (err as Error).message, quota: err instanceof QuotaError })
          } finally {
            busyTrips.delete(trip.id)
            res.end()
          }
          return
        }
      }

      if (req.method === 'POST' && p === '/api/plan') {
        const parsed = validate(await body(req))
        if (typeof parsed === 'string') return json(res, 400, { error: parsed })
        if (running >= 1) return json(res, 429, { error: 'Hive is planning another trip right now. Try again in a minute.' })
        try {
          limiter.take('plan', ip)
        } catch (err) {
          if (quota(res, err)) return
          throw err
        }
        running++
        const send = ndjson(res)
        try {
          const profile = await loadProfile()
          const trip = await runHive(parsed, { llm: makeLlm(), fetch: f, profile, maxSteps: 10, onStep: (e) => send({ type: 'step', ...e }) })
          if (!trip.stops.length) throw new Error("Hive couldn't finish a plan this time (the free AI models are busy). Please try again in a few minutes.")
          send({ type: 'step', step: 98, tool: 'enrich', note: 'Routing between stops, pricing the trip, finding photos, packing list' })
          await enrich(trip, route, f)
          await saveTrip(trip)
          send({ type: 'done', trip })
        } catch (err) {
          send({ type: 'error', error: (err as Error).message, quota: err instanceof QuotaError })
        } finally {
          running--
          res.end()
        }
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (err) {
      if (!res.headersSent && err instanceof RequestBodyError) {
        return json(res, err.status, { error: err.message })
      }
      if (!res.headersSent) json(res, 500, { error: (err as Error).message })
      else res.end()
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  useHttpCache(join(DATA, 'http-cache.json'))
  makeServer().listen(PORT, () => console.log(`Hive listening on :${PORT}`))
}
