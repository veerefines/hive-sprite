import type { Issue, StopLike } from './lib/planCheck.ts'
import type { DayWeather, Place } from './world.ts'
import type { LegOption, LegMode } from './lib/legs.ts'
import type { BudgetEstimate } from './lib/budget.ts'
import type { Photo } from './photos.ts'

export type Pace = 'chill' | 'balanced' | 'packed'

export interface TripRequest {
  prompt: string
  destination: string
  startDate: string
  endDate: string
  pace?: Pace
  dailyBudget?: number
  wakeTime?: string
  travellers?: number
  origin?: string
  interests?: string[]
  diet?: string
  slackChannel?: string
}

export interface Stop extends StopLike {
  /** Exact name of the place Hive found (the grounding key). */
  place?: string
  address?: string
  kind?: string
  note?: string
  tip?: string
  photo?: Photo | null
}

export interface Stay {
  name: string
  lat: number
  lng: number
  area?: string
  why?: string
  nightlyUsd?: number
  photo?: Photo | null
}

export interface Leg {
  date: string
  fromId: string
  toId: string
  best: LegOption
  options: LegOption[]
  why: string
  /** [lat, lng] pairs along the street route, when routing answered. */
  path?: Array<[number, number]>
  estimated: boolean
}

export interface Money {
  country?: string
  currency: string
  homeCurrency: string
  /** units of X per 1 USD */
  rates: Record<string, number>
  live: boolean
  cashShare?: number
}

export interface Proposal {
  id: string
  createdAt: string
  ask: string
  summary: string
  stops: Stop[]
  stay?: Stay
  diff: { added: string[]; removed: string[]; moved: string[] }
  status: 'open' | 'accepted' | 'rejected' | 'stale'
}

export interface ChatMsg {
  role: 'user' | 'hive'
  text: string
  at: string
  proposalId?: string
}

export interface Trip {
  id: string
  createdAt: string
  updatedAt: string
  request: TripRequest
  center?: { lat: number; lng: number; name: string; address?: string }
  originPoint?: { lat: number; lng: number } | null
  stops: Stop[]
  stay?: Stay
  tips: string[]
  issues: Issue[]
  forecast: Record<string, DayWeather>
  summary: string
  title: string
  legs: Leg[]
  budget?: BudgetEstimate & { cashUsd?: number }
  money?: Money
  ideas: Record<string, Array<Place & { photo?: Photo | null }>>
  rainyBackups: Array<Place & { photo?: Photo | null }>
  cover?: Photo | null
  packing?: PackItem[]
  /** Every place Hive found while researching, keyed by name. */
  known: Record<string, Place>
  log: Array<{ step: number; tool: string; note: string }>
  chat: ChatMsg[]
  proposals: Proposal[]
  forecastCheckedAt?: string
  shared?: { channel: string; ok: boolean; error?: string }
}

export interface PackItem {
  id: string
  label: string
  group: string
  why?: string
  done: boolean
}

export type { LegMode }
