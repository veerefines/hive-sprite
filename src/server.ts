/**
 * Hive's HTTP front door. Runs as a Sprite service on port 8080.
 * Trips are saved as JSON on the Sprite's persistent disk.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayLlm, slackPost, type Llm } from './connectors.ts'
import { formatForSlack, runHive, type TripRequest, type TripResult } from './agent.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = process.env.HIVE_PUBLIC_DIR ?? join(HERE, '..', 'public')
const DATA = process.env.HIVE_DATA_DIR ?? join(HERE, '..', 'data')
const PORT = Number(process.env.PORT ?? 8080)
const DATE = /^\d{4}-\d{2}-\d{2}$/

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 64_000) throw new Error('Request too large')
    chunks.push(c as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
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
  if (!DATE.test(startDate) || !DATE.test(endDate)) return 'dates must be YYYY-MM-DD'
  if (endDate < startDate) return 'endDate is before startDate'
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1
  if (days > 5) return 'Hive plans up to 5 days at a time'
  const pace = ['chill', 'balanced', 'packed'].includes(String(r.pace)) ? (r.pace as TripRequest['pace']) : 'balanced'
  const channel = String(r.slackChannel ?? '').trim()
  return {
    destination,
    startDate,
    endDate,
    pace,
    prompt: String(r.prompt ?? '').slice(0, 1000) || `Plan a great ${days}-day trip to ${destination}.`,
    dailyBudget: Number(r.dailyBudget) > 0 ? Number(r.dailyBudget) : undefined,
    wakeTime: /^\d{2}:\d{2}$/.test(String(r.wakeTime)) ? String(r.wakeTime) : undefined,
    slackChannel: /^[#@]?[\w-]{1,80}$/.test(channel) ? channel : undefined,
  }
}

async function saveTrip(t: TripResult) {
  await mkdir(join(DATA, 'trips'), { recursive: true })
  await writeFile(join(DATA, 'trips', `${t.id}.json`), JSON.stringify(t, null, 2))
}

async function listTrips() {
  const dir = join(DATA, 'trips')
  const files = await readdir(dir).catch(() => [] as string[])
  const trips = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as TripResult),
  )
  return trips
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({ id: t.id, createdAt: t.createdAt, destination: t.request.destination, startDate: t.request.startDate, endDate: t.request.endDate, stops: t.stops.length }))
}

const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' }

let running = 0
// Public URL guard: cap plans per UTC day so strangers can't drain the LLM credit.
const DAILY_LIMIT = Number(process.env.HIVE_DAILY_LIMIT ?? 40)
const usage = { day: '', count: 0 }
export function takeQuota(now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10)
  if (usage.day !== day) Object.assign(usage, { day, count: 0 })
  if (usage.count >= DAILY_LIMIT) return false
  usage.count++
  return true
}

export function makeServer(llmFactory: () => Llm = () => gatewayLlm()) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = STATIC[url.pathname]
        const content = await readFile(join(PUBLIC, file))
        res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()!] })
        return res.end(content)
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          llmConnector: !!process.env.HIVE_LLM_GATEWAY,
          slackConnector: !!process.env.HIVE_SLACK_GATEWAY,
          host: process.env.SPRITE_NAME ?? 'local',
          plansLeftToday: Math.max(0, DAILY_LIMIT - (usage.day === new Date().toISOString().slice(0, 10) ? usage.count : 0)),
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/trips') return json(res, 200, await listTrips())
      const m = /^\/api\/trips\/([\w-]{1,40})(\/share)?$/.exec(url.pathname)
      if (m) {
        const raw = await readFile(join(DATA, 'trips', `${m[1]}.json`), 'utf8').catch(() => null)
        if (!raw) return json(res, 404, { error: 'not found' })
        const trip = JSON.parse(raw) as TripResult
        if (req.method === 'GET' && !m[2]) return json(res, 200, trip)
        if (req.method === 'POST' && m[2]) {
          const { channel } = (await body(req)) as { channel?: string }
          if (!channel) return json(res, 400, { error: 'channel required' })
          const r = await slackPost(channel, formatForSlack(trip))
          trip.shared = { channel, ...r }
          await saveTrip(trip)
          return json(res, r.ok ? 200 : 502, trip.shared)
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/plan') {
        const parsed = validate(await body(req))
        if (typeof parsed === 'string') return json(res, 400, { error: parsed })
        if (running >= 2) return json(res, 429, { error: 'Hive is busy, try again in a minute' })
        if (!takeQuota()) return json(res, 429, { error: 'Hive has planned its daily quota of trips. Past trips are still browsable below.' })
        running++
        // Stream progress as NDJSON so the page can show each agent step.
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
        try {
          const trip = await runHive(parsed, {
            llm: llmFactory(),
            onStep: (e) => res.write(JSON.stringify({ type: 'step', ...e }) + '\n'),
          })
          await saveTrip(trip)
          res.write(JSON.stringify({ type: 'done', trip }) + '\n')
        } catch (err) {
          res.write(JSON.stringify({ type: 'error', error: (err as Error).message }) + '\n')
        } finally {
          running--
          res.end()
        }
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message })
      else res.end()
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  makeServer().listen(PORT, () => console.log(`Hive listening on :${PORT}`))
}
