import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const usage = (input: number, output: number) => ({
  model: 'x',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const SPAWNED: Record<string, { model: string; agentId: string }> = {
  coder: { model: 'claude-haiku-5-5', agentId: 'a-coder' },
  reviewer: { model: 'claude-sonnet-5-5', agentId: 'a-reviewer' },
}

const usageAt = (weekly: number, usd: number) => ({
  startedAt: 0,
  context: { tokens: 0, window: 1_000_000, percent: 0 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 12 },
    { kind: 'seven_day', percentUsed: weekly },
  ],
  cost: { usd },
})

type Now = { weekly: number; usd: number }

// The engine beneath the mod: every call it makes, answered from memory. `now` is what
// $.session.usage() reads: the weekly % (whole points) and the session's cost.
const engine = (on: On, files: Record<string, string> = {}): Now => {
  const now = { weekly: 2, usd: 0 }
  mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] } : { deny: `${e.path}: no such file` }) as never)
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('session.usage', () => ({ value: usageAt(now.weekly, now.usd) }) as never)
  on('agent.spawn', ($, e) => SPAWNED[e.subagentType])
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(100_000, 2_000) } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  return now
}

const step = async ($: Engine, model: string, effort: string, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort, messageCount: 1, agentId } as never)) {
  }
}

// A model request by main that ends with the week at `weekly` and the session at `usd`.
const at = async ($: Engine, now: Now, weekly: number, usd: number) => {
  Object.assign(now, { weekly, usd })
  await step($, 'claude-opus-5-5', 'medium')
}

// main on Opus ($0.44 a step), coder on Haiku ($0.011), reviewer on Sonnet ($0.22).
const spawnAndStep = async ($: Engine) => {
  for (const type of ['coder', 'reviewer']) {
    await $.agent.spawn({ tool_use_id: type, prompt: 'p', description: 'd', subagentType: type, background: false, fork: false, parentModel: 'claude-opus-5-5' } as never)
  }
  await step($, 'claude-opus-5-5', 'medium')
  await step($, 'claude-haiku-5-5', 'max', 'a-coder')
  await step($, 'claude-sonnet-5-5', 'high', 'a-reviewer')
}

// The one line drawn above the prompt while `agentId`'s transcript (or main's) is on screen.
const lineFor = async ($: Engine, agentId?: string) => {
  const ui = await $.ui.mount({
    plugin: 'agent-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: agentId ? { agentId } : {} },
  } as never)
  return (await ui.findAll({}))
    .filter(el => el.type === 'Text')
    .map(el => el.text)
    .join('')
}

// What an earlier version left in $.state under `key`: read until the mod first writes it.
const seed = (on: On, key: 'agents' | 'limits', value: unknown) => {
  let isWritten = false
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === key) isWritten = true
    return next(e)
  })
  on('state.get', async ($, e, next) => {
    const stored = (await next(e)) as { value: { value: unknown; version: number } }
    if (isWritten || (e as { key?: string }).key !== key) return stored as never
    // Keep the engine's version, so the mod's first write over the seed lands.
    return { value: { ...stored.value, value } } as never
  })
}

// $.store beneath the mod, in memory, so a test can read back what the mod saved.
const store = (on: On, entries: Record<string, unknown> = {}) => {
  const saved = { ...entries }
  on('store.get', ($, e) => ({ value: saved[e.key] }) as never)
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  return saved
}

test('the first tick gives a number at once; the second measures USD per point', async ($, on) => {
  const now = engine(on)
  const saved = store(on)

  await at($, now, 3, 11.027)
  await at($, now, 4, 11.106) // the week ticked 3 → 4 near $11.07
  await at($, now, 4, 12.66)
  // $11.07 bought the week's first 4 points: $2.77 a point. main is the session's $12.66.
  expect(await lineFor($)).toBe('main opus-5.5 medium 4.6%/4.6%')

  await at($, now, 4, 13.85)
  await at($, now, 5, 13.95) // ticked 4 → 5 near $13.90: that point cost $2.83
  await at($, now, 5, 14.2)
  expect(await lineFor($)).toBe('main opus-5.5 medium 5%/5.1%')
  expect(Math.round((saved.usdPerWeeklyPoint as number) * 1e4) / 1e4).toBe(2.8335)
})

test('a rate saved by an earlier session applies at once, to main and each subagent', async ($, on) => {
  const now = engine(on)
  store(on, { usdPerWeeklyPoint: 2 })

  Object.assign(now, { weekly: 7, usd: 1.0 })
  await spawnAndStep($)
  expect(await lineFor($)).toBe('main opus-5.5 medium 0.4%/7%') // (1.00 - 0.231) / 2
  expect(await lineFor($, 'a-coder')).toBe('coder haiku-5.5 max <0.1%/7%') // 0.011 / 2
  expect(await lineFor($, 'a-reviewer')).toBe('reviewer sonnet-5.5 high 0.1%/7%') // 0.22 / 2
})

test('the tick v0.4 kept carries over, so the number shows straight after the update', async ($, on) => {
  const now = engine(on)
  store(on)
  seed(on, 'limits', { sevenDay: 4, sevenDayResetsAt: null, fiveHour: 30, usd: 12.43, tickPct: 4, tickCost: 11.106 })

  await at($, now, 4, 12.66)
  expect(await lineFor($)).toBe('main opus-5.5 medium 4.6%/4.6%')
})

test('a rate kept in ~/.cache/agent-meter/usd-per-point applies; the week holds at least the session', async ($, on) => {
  const now = engine(on, { '/home/test/.cache/agent-meter/usd-per-point': '3.0100\n' })
  store(on)

  await at($, now, 5, 15.73)
  expect(await lineFor($)).toBe('main opus-5.5 medium 5.2%/5.2%') // 15.73 / 3.01
})

test('a measured rate is written to the file too', async ($, on) => {
  const files: Record<string, string> = {}
  const now = engine(on, files)
  store(on)

  await at($, now, 3, 11.027)
  await at($, now, 4, 11.106)
  await at($, now, 4, 13.984)
  await at($, now, 5, 14.169)
  expect(files['/home/test/.cache/agent-meter/usd-per-point']).toBe('3.0100\n') // 14.0765 - 11.0665
})

test('before any tick, with no saved rate, the share waits', async ($, on) => {
  const now = engine(on)
  store(on)

  await at($, now, 4, 8.65)
  expect(await lineFor($)).toBe('main opus-5.5 medium …/4%')
})

test('a tick seen across a long gap pins nothing', async ($, on) => {
  const now = engine(on)
  store(on)

  await at($, now, 3, 1.0)
  await at($, now, 4, 5.0) // $4.00 apart: the tick happened somewhere in there
  expect(await lineFor($)).toBe('main opus-5.5 medium …/4%')
})

test('a row saved by an earlier version (no cost) never shows NaN', async ($, on) => {
  const now = engine(on)
  store(on, { usdPerWeeklyPoint: 1 })
  seed(on, 'agents', { main: { type: 'main', model: 'claude-opus-5-5', effort: 'medium', inTokens: 5, outTokens: 1, isDone: false, order: 0 } })

  await at($, now, 3, 0.5)
  expect(await lineFor($)).toBe('main opus-5.5 medium 0.5%/3%')
})
