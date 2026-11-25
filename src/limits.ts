/**
 * Free-tier guardrails. Everything that costs anything is counted here and
 * the counters are saved on the Sprite's disk, so a restart or a cold boot
 * doesn't reset them.
 *
 *  - model calls per UTC day, kept under OpenRouter's free-model allowance
 *  - plans and chats per day, globally and per visitor (per IP, per hour + day)
 *  - one plan at a time, one chat per trip at a time (enforced in server.ts)
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type Kind = 'plan' | 'chat'

export interface LimitConfig {
  llmCallsPerDay: number
  plansPerDay: number
  chatsPerDay: number
  ipPlansPerHour: number
  ipPlansPerDay: number
  ipChatsPerHour: number
  ipChatsPerDay: number
}

const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export function configFromEnv(env = process.env): LimitConfig {
  return {
    // OpenRouter gives accounts without purchased credit ~50 free-model requests a day.
    llmCallsPerDay: n(env.HIVE_LLM_CALLS_PER_DAY, 45),
    plansPerDay: n(env.HIVE_PLANS_PER_DAY, 6),
    chatsPerDay: n(env.HIVE_CHATS_PER_DAY, 20),
    ipPlansPerHour: n(env.HIVE_IP_PLANS_PER_HOUR, 1),
    ipPlansPerDay: n(env.HIVE_IP_PLANS_PER_DAY, 2),
    ipChatsPerHour: n(env.HIVE_IP_CHATS_PER_HOUR, 5),
    ipChatsPerDay: n(env.HIVE_IP_CHATS_PER_DAY, 10),
  }
}

interface IpUse {
  hour: string
  planH: number
  chatH: number
  planD: number
  chatD: number
}

interface State {
  day: string
  llmCalls: number
  plans: number
  chats: number
  ips: Record<string, IpUse>
}

export class QuotaError extends Error {
  retryAfterSec: number
  constructor(message: string, retryAfterSec: number) {
    super(message)
    this.retryAfterSec = retryAfterSec
  }
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const hourOf = (d: Date) => d.toISOString().slice(0, 13)
function secondsUntil(d: Date, unit: 'hour' | 'day'): number {
  const next = new Date(d)
  if (unit === 'hour') next.setUTCMinutes(60, 0, 0)
  else next.setUTCHours(24, 0, 0, 0)
  return Math.max(1, Math.round((next.getTime() - d.getTime()) / 1000))
}

export class Limiter {
  private state: State
  cfg: LimitConfig
  private file?: string
  private now: () => Date
  constructor(cfg: LimitConfig, file?: string, now: () => Date = () => new Date()) {
    this.cfg = cfg
    this.file = file
    this.now = now
    this.state = { day: '', llmCalls: 0, plans: 0, chats: 0, ips: {} }
    if (file) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) }
      } catch {
        /* first run */
      }
    }
  }

  private roll(): State {
    const d = this.now()
    if (this.state.day !== dayOf(d)) this.state = { day: dayOf(d), llmCalls: 0, plans: 0, chats: 0, ips: {} }
    return this.state
  }

  private ip(ip: string): IpUse {
    const s = this.roll()
    const h = hourOf(this.now())
    const u = (s.ips[ip] ??= { hour: h, planH: 0, chatH: 0, planD: 0, chatD: 0 })
    if (u.hour !== h) Object.assign(u, { hour: h, planH: 0, chatH: 0 })
    return u
  }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state))
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      /* best effort */
    }
  }

  /** Reserve one plan or chat for this visitor, or throw QuotaError. */
  take(kind: Kind, ip: string): void {
    const s = this.roll()
    const d = this.now()
    const u = this.ip(ip)
    const c = this.cfg
    // Enough model calls left for a typical run?
    const need = kind === 'plan' ? 6 : 2
    if (s.llmCalls + need > c.llmCallsPerDay) throw new QuotaError("Hive has used today's free AI allowance. It resets at midnight UTC; past trips stay browsable.", secondsUntil(d, 'day'))
    if (kind === 'plan') {
      if (s.plans >= c.plansPerDay) throw new QuotaError(`Hive plans ${c.plansPerDay} trips a day on the free tier and today's are used up. Try again after midnight UTC.`, secondsUntil(d, 'day'))
      if (u.planD >= c.ipPlansPerDay) throw new QuotaError(`You've planned ${c.ipPlansPerDay} trips today, the limit per visitor. You can still chat with Hive about them.`, secondsUntil(d, 'day'))
      if (u.planH >= c.ipPlansPerHour) throw new QuotaError('One new trip per hour per visitor. You can still ask Hive to change your current trip.', secondsUntil(d, 'hour'))
      s.plans++
      u.planH++
      u.planD++
    } else {
      if (s.chats >= c.chatsPerDay) throw new QuotaError("Hive has answered today's free quota of messages. Try again after midnight UTC.", secondsUntil(d, 'day'))
      if (u.chatD >= c.ipChatsPerDay) throw new QuotaError(`You've sent ${c.ipChatsPerDay} messages today, the limit per visitor.`, secondsUntil(d, 'day'))
      if (u.chatH >= c.ipChatsPerHour) throw new QuotaError(`Up to ${c.ipChatsPerHour} messages an hour per visitor. Back soon!`, secondsUntil(d, 'hour'))
      s.chats++
      u.chatH++
      u.chatD++
    }
    this.save()
  }

  /** Count one model call; throws once the day's allowance is gone. */
  llmCall(): void {
    const s = this.roll()
    if (s.llmCalls >= this.cfg.llmCallsPerDay) throw new QuotaError("Hive ran out of today's free AI allowance mid-run. It resets at midnight UTC.", secondsUntil(this.now(), 'day'))
    s.llmCalls++
    this.save()
  }

  status(ip?: string) {
    const s = this.roll()
    const c = this.cfg
    const u = ip ? this.ip(ip) : undefined
    return {
      aiCallsLeft: Math.max(0, c.llmCallsPerDay - s.llmCalls),
      plansLeft: Math.max(0, Math.min(c.plansPerDay - s.plans, u ? c.ipPlansPerDay - u.planD : Infinity, u ? c.ipPlansPerHour - u.planH : Infinity, Math.floor((c.llmCallsPerDay - s.llmCalls) / 6))),
      chatsLeft: Math.max(0, Math.min(c.chatsPerDay - s.chats, u ? c.ipChatsPerDay - u.chatD : Infinity, u ? c.ipChatsPerHour - u.chatH : Infinity, Math.floor((c.llmCallsPerDay - s.llmCalls) / 2))),
      resetsInSec: secondsUntil(this.now(), 'day'),
    }
  }
}

/**
 * Polite outbound calls: a minimum gap per host, a cap on in-flight
 * requests, and a small in-memory cache for GETs.
 */
const GAP_MS: Record<string, number> = {
  'nominatim.openstreetmap.org': 1100, // Nominatim policy: max 1 req/s
  'photon.komoot.io': 250,
  'overpass-api.de': 2000,
  'en.wikipedia.org': 60,
  'api.open-meteo.com': 200,
  'api.frankfurter.app': 200,
  'routing.openstreetmap.de': 150,
}
const nextAt = new Map<string, number>()
const cache = new Map<string, { at: number; status: number; body: string; type: string }>()
const CACHE_MAX = 1500
/** Places and photos barely change: keep them a week. Weather and FX: 6 hours. */
const LONG_TTL_HOSTS = new Set(['photon.komoot.io', 'nominatim.openstreetmap.org', 'en.wikipedia.org', 'overpass-api.de'])
const ttl = (url: string) => {
  try {
    return LONG_TTL_HOSTS.has(new URL(url).host) ? 7 * 86400_000 : 6 * 3600_000
  } catch {
    return 6 * 3600_000
  }
}
let cacheFile: string | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
function persistSoon() {
  if (!cacheFile || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    try {
      mkdirSync(dirname(cacheFile!), { recursive: true })
      const keep = [...cache.entries()].filter(([u, v]) => LONG_TTL_HOSTS.has(new URL(u).host) && Date.now() - v.at < ttl(u)).slice(-CACHE_MAX)
      writeFileSync(`${cacheFile}.tmp`, JSON.stringify(keep))
      renameSync(`${cacheFile}.tmp`, cacheFile!)
    } catch {
      /* best effort */
    }
  }, 3000)
  saveTimer.unref?.()
}
/** Load the on-disk cache (places, photos) once at startup. */
export function useHttpCache(file: string) {
  cacheFile = file
  try {
    for (const [k, v] of JSON.parse(readFileSync(file, 'utf8')) as Array<[string, { at: number; status: number; body: string; type: string }]>) cache.set(k, v)
  } catch {
    /* first run */
  }
}
let inflight = 0
const waiters: Array<() => void> = []
const MAX_INFLIGHT = 8

async function slot(host: string) {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((r) => waiters.push(r))
  inflight++
  const gap = GAP_MS[host] ?? 100
  const now = Date.now()
  const at = Math.max(now, nextAt.get(host) ?? 0)
  nextAt.set(host, at + gap)
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
}
function release() {
  inflight--
  waiters.shift()?.()
}

export function politeFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return ''
      }
    })()
    const key = method === 'GET' ? url : ''
    const hit = key ? cache.get(key) : undefined
    if (hit && Date.now() - hit.at < ttl(key)) return new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.type } })
    await slot(host)
    try {
      const res = await base(input as string, { ...init, signal: init?.signal ?? AbortSignal.timeout(12_000) })
      if (key && res.ok) {
        const body = await res.text()
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
        const type = res.headers.get('content-type') ?? 'application/json'
        cache.set(key, { at: Date.now(), status: res.status, body, type })
        persistSoon()
        return new Response(body, { status: res.status, headers: { 'content-type': type } })
      }
      return res
    } finally {
      release()
    }
  }) as typeof fetch
}
