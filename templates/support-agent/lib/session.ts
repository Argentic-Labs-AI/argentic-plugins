// One visitor's run: what Argentic was asked, what finished, and the sandbox inbox.
import type { Store } from './store'

export interface Email {
  /** The action's stable key. The sandbox mail provider keeps one message per key. */
  key: string
  to: string
  subject: string
  body: string
  at: string
}

export type LineKind = 'info' | 'wake' | 'ran' | 'skip' | 'dup' | 'kill' | 'done' | 'error'
export interface Line {
  at: string
  kind: LineKind
  text: string
}

export type Status = 'idle' | 'running' | 'killed' | 'done' | 'error'

export interface Session {
  id: string
  agent: string
  runId: string
  status: Status
  /** Finished actions, by `${agent}:${seq}`: the result is what the model is told on resume. */
  ledger: Record<string, { tool: string; result: unknown; at: string }>
  outbox: Email[]
  wakes: string[]
  log: Line[]
  reply?: string
  spentUsd: number
  /** Counts runs of this run id, so a stale loop can tell it was replaced. */
  attempt: number
  beat: number
}

export interface View {
  status: Status
  agent: string
  wakes: string[]
  log: Line[]
  outbox: Email[]
  finished: number
  reply?: string
  spentUsd: number
}

const rand = () => Math.random().toString(36).slice(2, 8)

export function freshSession(id: string): Session {
  const tag = rand()
  return { id, agent: `support-${tag}`, runId: `run-${tag}`, status: 'idle', ledger: {}, outbox: [], wakes: [], log: [], spentUsd: 0, attempt: 0, beat: 0 }
}

export const view = (s: Session): View => ({
  status: s.status,
  agent: s.agent,
  wakes: s.wakes,
  log: s.log,
  outbox: s.outbox,
  finished: Object.keys(s.ledger).length,
  reply: s.reply,
  spentUsd: s.spentUsd,
})

export const sessionKey = (id: string) => `session:${id}`
export const killKey = (id: string) => `kill:${id}`

export async function loadSession(store: Store, id: string): Promise<Session> {
  return (await store.get<Session>(sessionKey(id))) ?? freshSession(id)
}

export const saveSession = (store: Store, s: Session) => store.set(sessionKey(s.id), { ...s, beat: Date.now() })
