import { atom, read, update } from 'claude-code'
import type { Api, Register, SessionCost, SessionRateLimit, TurnUsage } from 'claude-code'

import type { AgentRow, Crossing, Limits } from '../types'

const MAIN = 'main'
// USD of session cost per weekly point, measured once and kept across sessions: in $.store,
// and as plain text in ~/.cache/agent-meter/usd-per-point, which you can read or correct.
const USD_PER_POINT = 'usdPerWeeklyPoint'
const RATE_FILE = '.cache/agent-meter/usd-per-point'
// Two consecutive readings at most this far apart (USD) pin a crossing closely enough to use.
const MAX_CROSSING_GAP = 1

const agents = atom({ plugin: 'agent-meter', key: 'agents' } as const, {} as Record<string, AgentRow>)
const limits = atom({ plugin: 'agent-meter', key: 'limits' } as const, {
  sevenDay: null,
  fiveHour: null,
  usd: null,
  firstCross: null,
  lastCross: null,
  rate: null,
} as Limits)

// USD per million tokens (API list prices, 2026-10). They split the session's cost between
// agents. Cache writes are priced at 2x input: the 1-hour cache these agents use.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  fable: { input: 10, output: 50, cacheRead: 0.25 },
  opus: { input: 4, output: 20, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01 },
}
const CACHE_WRITE = 2

const priceOf = (model: string) =>
  PRICES[Object.keys(PRICES).find(family => model.includes(family)) ?? 'opus']

const costOf = (model: string, u: TurnUsage) => {
  const p = priceOf(model)
  const cost =
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.input * CACHE_WRITE +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.output_tokens ?? 0) * p.output) /
    1_000_000
  return Number.isFinite(cost) ? cost : 0
}

// A row saved by an earlier version of this mod (or a bad sum) may lack a usable cost.
const costIn = (a: AgentRow) => (Number.isFinite(a.cost) ? a.cost : 0)

// claude-opus-5-5 -> opus-5.5
const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/-(\d{8})$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')

const shortEffort = (effort: string | number | undefined) =>
  effort === undefined ? null : typeof effort === 'number' ? `${Math.round(effort / 1000)}k` : effort

const pct = (n: number) => (!Number.isFinite(n) ? '0%' : n > 0 && n < 0.1 ? '<0.1%' : `${Math.round(n * 10) / 10}%`)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Earlier versions kept other fields; v0.4 kept its first crossing as tickPct/tickCost.
const migrate = (stored: Limits): Limits => {
  const old = stored as Partial<Limits> & { tickPct?: unknown; tickCost?: unknown }
  const legacy: Crossing | null =
    typeof old.tickPct === 'number' && typeof old.tickCost === 'number' ? { pct: old.tickPct, usd: old.tickCost } : null
  return {
    sevenDay: old.sevenDay ?? null,
    fiveHour: old.fiveHour ?? null,
    usd: old.usd ?? null,
    firstCross: old.firstCross ?? legacy,
    lastCross: old.lastCross ?? legacy,
    rate: old.rate ?? null,
  }
}

// USD per weekly point: measured, or until then a first estimate from the first crossing. The
// week starts at 0%, so taking this session as the week's only usage, its cost at the crossing
// bought all the points up to it.
const usdPerPoint = (lim: Limits) =>
  lim.rate ?? (lim.firstCross && lim.firstCross.pct > 0 ? lim.firstCross.usd / lim.firstCross.pct : null)

const asRate = (v: unknown) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

const savedRate = async ($: Api) => {
  const stored = asRate(await $.store.get(USD_PER_POINT))
  if (stored !== null) return stored
  try {
    return asRate(await $.fs.read(`${await $.env.get('HOME')}/${RATE_FILE}`))
  } catch {
    return null // no file yet
  }
}

const saveRate = async ($: Api, rate: number) => {
  await $.store.set(USD_PER_POINT, rate)
  try {
    await $.fs.write(`${await $.env.get('HOME')}/${RATE_FILE}`, `${rate.toFixed(4)}\n`)
  } catch {}
}

// The last readings, written to ~/.cache/agent-meter/readings.json to check the meter against.
const readings: { at: number; rateLimits: readonly SessionRateLimit[]; usd: number | null; usdPerPoint: number | null; limits: Limits }[] = []

const log = async ($: Api, rateLimits: readonly SessionRateLimit[], cost: SessionCost | undefined, lim: Limits) => {
  const home = await $.env.get('HOME')
  if (!home) return
  readings.push({ at: await $.clock.now(), rateLimits, usd: cost?.usd ?? null, usdPerPoint: usdPerPoint(lim), limits: lim })
  readings.splice(0, Math.max(0, readings.length - 50))
  await $.fs.write(`${home}/.cache/agent-meter/readings.json`, JSON.stringify(readings, null, 1))
}

// Claude Code reports the weekly % in whole points. Each time it ticks up between two close
// readings, the session's cost at that moment is pinned; the cost between the first and the
// latest crossing bought exactly the points between them: USD per weekly point.
const measure = async ($: Api, rateLimits: readonly SessionRateLimit[], cost: SessionCost | undefined) => {
  const seven = rateLimits.find(r => r.kind === 'seven_day')?.percentUsed
  const five = rateLimits.find(r => r.kind === 'five_hour')?.percentUsed
  const spent = cost?.usd
  const saved = migrate(await read($, limits)).rate === null ? await savedRate($) : null
  const found = { rate: null as number | null }

  await update($, limits, stored => {
    const prev = migrate(stored)
    const next: Limits = {
      ...prev,
      sevenDay: seven ?? prev.sevenDay,
      fiveHour: five ?? prev.fiveHour,
      usd: spent ?? prev.usd,
      rate: prev.rate ?? saved,
    }
    if (seven === undefined || spent === undefined || prev.sevenDay === null || seven === prev.sevenDay) return next
    if (seven < prev.sevenDay) return { ...next, firstCross: null, lastCross: null } // the week reset
    if (prev.usd === null || spent - prev.usd > MAX_CROSSING_GAP) return next // too far apart to pin
    const cross: Crossing = { pct: seven, usd: (prev.usd + spent) / 2 }
    const first = prev.firstCross ?? cross
    if (cross.pct > first.pct) found.rate = (cross.usd - first.usd) / (cross.pct - first.pct)
    return { ...next, firstCross: first, lastCross: cross, rate: found.rate ?? next.rate }
  })

  if (found.rate !== null) await saveRate($, found.rate)
  try {
    await log($, rateLimits, cost, await read($, limits))
  } catch {}
}

// "coder haiku-5.5 max 0.1%/4.6%": this agent's share of the week / the week used so far.
const line = (id: string, a: AgentRow, all: Record<string, AgentRow>, lim: Limits, week: number) => {
  const name = id === MAIN ? 'main' : a.type
  const effort = a.effort ? ` ${a.effort}` : ''
  const head = `${name} ${shortModel(a.model)}${effort}`
  const rate = usdPerPoint(lim)
  if (rate === null) return `${head} …/${pct(week)}`

  // The reported week is whole points. Past the latest crossing, spending fills in the
  // fraction; and the week holds at least what this session itself used.
  const sinceCross = lim.lastCross && lim.usd !== null ? lim.lastCross.pct + (lim.usd - lim.lastCross.usd) / rate : 0
  const session = lim.usd !== null ? lim.usd / rate : 0
  const weekNow = clamp(Math.max(sinceCross, session), week, week + 0.9)
  // Claude Code's session cost covers everything since the session started, including steps
  // from before this mod loaded: main is that, less what the subagents cost.
  const subagents = Object.entries(all).reduce((sum, [k, r]) => (k === MAIN ? sum : sum + costIn(r)), 0)
  const cost = id === MAIN && lim.usd !== null ? Math.max(costIn(a), lim.usd - subagents) : costIn(a)
  return `${head} ${pct(Math.min(cost / rate, weekNow))}/${pct(weekNow)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status(undefined) // earlier versions pinned a status line; this one draws above the prompt
    const usage = await $.session.usage()
    await measure($, usage.rateLimits, usage.cost)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await measure($, e.rateLimits, e.cost)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    // Never let the meter's bookkeeping fail a spawn that already happened.
    try {
      if (id !== undefined) {
        const order = await $.clock.now()
        await update($, agents, all => ({
          ...all,
          [id]: { type: e.subagentType, model: result.model, effort: null, cost: 0, isDone: false, order },
        }))
      }
    } catch {}
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId ?? MAIN
    const u = result.usage
    const order = await $.clock.now()
    await update($, agents, all => {
      // Skip the engine's own loops (compaction, memory): only main and spawned subagents.
      if (id !== MAIN && !all[id]) return all
      const prev = all[id] ?? { type: 'main', model: e.model, effort: null, cost: 0, isDone: false, order }
      return {
        ...all,
        [id]: {
          ...prev,
          model: e.model,
          effort: shortEffort(e.effort) ?? prev.effort,
          cost: costIn(prev) + (u ? costOf(e.model, u) : 0),
          isDone: false,
        },
      }
    })
    // session.measure fires only when a window moves a whole point; read the latest each step.
    const now = await $.session.usage()
    await measure($, now.rateLimits, now.cost)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id], isDone: true } } : all))
    }
    return result
  })

  // One line above the prompt, for the transcript on screen (main's, or an agent's).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const id = e.props.view.agentId ?? MAIN
    const all = await read($, agents)
    const lim = migrate(await read($, limits))
    const a = all[id]
    if (!a || lim.sevenDay === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return Box({ children: [Text({ dimColor: true, children: line(id, a, all, lim, lim.sevenDay) })] })
  })
}
