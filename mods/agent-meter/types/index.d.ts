export type AgentRow = {
  type: string
  model: string
  effort: string | null
  /** Token cost in USD at API list prices since the mod started counting. */
  cost: number
  isDone: boolean
  order: number
}

/** A moment the weekly % ticked up, and the session's cost then. */
export type Crossing = { pct: number; usd: number }

export type Limits = {
  /** Weekly % as Claude Code reports it: whole points. */
  sevenDay: number | null
  fiveHour: number | null
  /** The session's cost at the last reading: Claude Code's figure, from the session's start. */
  usd: number | null
  /** The first and the latest crossing this session saw. */
  firstCross: Crossing | null
  lastCross: Crossing | null
  /** USD per weekly point, measured between two crossings (this session's, or saved by an earlier one). */
  rate: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-meter': { agents: Record<string, AgentRow>; limits: Limits }
  }
}
