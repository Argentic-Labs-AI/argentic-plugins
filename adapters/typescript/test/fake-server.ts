// An in-memory server for the keep-your-loop routes (the wire contract), as a `fetch` for the Argentic client.
import { canonical, sha256 } from '../argentic.ts'

export interface StoredEvent {
  seq: number
  at: string
  kind: string
  payload: any
}

interface Run {
  events: StoredEvent[]
  seq: number
  spent: number
  maxUsd?: number
}

export class FakeServer {
  runs = new Map<string, Run>()
  /** Every POST /events body, in order. */
  writes: any[] = []
  /** Number of POST /open calls. */
  opens = 0
  /** Fail the next n event writes with this status (before anything is stored). */
  failNext: { status: number; body?: unknown; count: number } | undefined

  private run(agent: string, id: string): Run {
    const k = `${agent}/${id}`
    let r = this.runs.get(k)
    if (!r) this.runs.set(k, (r = { events: [], seq: 0, spent: 0 }))
    return r
  }

  events(agent: string, id: string, kind?: string): StoredEvent[] {
    const r = this.runs.get(`${agent}/${id}`)
    return (r?.events ?? []).filter((e) => !kind || e.kind === kind)
  }

  private append(r: Run, kind: string, payload: unknown): StoredEvent {
    const e = { seq: ++r.seq, at: new Date().toISOString(), kind, payload }
    r.events.push(e)
    return e
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const m = u.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)(\/open|\/events)?$/)
    if (!m) return json(404, { error: 'not_found' })
    const agent = decodeURIComponent(m[1]!)
    const id = decodeURIComponent(m[2]!)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const r = this.run(agent, id)

    if (m[3] === '/open' && method === 'POST') {
      this.opens++
      const limits = body.limits
      if (limits?.max_usd !== undefined) r.maxUsd = limits.max_usd
      const e = this.append(r, 'loop.run_started', { run: id, process: body.process, ...(limits ? { limits } : {}) })
      e.payload.epoch = e.seq
      return json(200, { run: id, epoch: e.seq, events: structuredClone(r.events) })
    }
    if (m[3] === '/events' && method === 'POST') {
      this.writes.push(body)
      if (this.failNext && this.failNext.count > 0) {
        this.failNext.count--
        return json(this.failNext.status, this.failNext.body ?? { error: 'boom' })
      }
      const latest = [...r.events].reverse().find((e) => e.kind === 'loop.run_started')
      if (!latest || body.epoch !== latest.seq) return json(409, { error: 'fenced', epoch: latest?.seq })
      const results: { type: string; key: string; status: string; seq: number }[] = []
      const pending: { kind: string; payload: any; ri?: number }[] = []
      let capped = false
      let spent = r.spent
      const has = (kind: string, key: string) => r.events.find((e) => e.kind === kind && e.payload.key === key)
      const hasModelStep = (key: string) => key && has('loop.model_step', key.split('.')[0]!)
      for (const ev of body.events as any[]) {
        const { type, ...rest } = ev
        // run_finished carries only { reply? }: its key is implicit, so one that is sent is rejected.
        if (type === 'run_finished' && 'key' in ev) return json(400, { error: 'bad_request', detail: "unexpected field: key" })
        const key: string = type === 'run_finished' ? 'run' : ev.key
        const kind = `loop.${type}`
        const bodyHash = sha256(canonical(ev))
        const found = r.events.find((e) => e.kind === kind && (e.payload.key ?? 'run') === key)
        if (found) {
          if (found.payload.body_hash !== bodyHash) return json(409, { error: 'divergent', key, type })
          results.push({ type, key, status: 'existed', seq: found.seq })
          continue
        }
        if (type === 'tool_started') {
          if (!hasModelStep(key)) return json(400, { error: 'unrecorded', key })
          if (r.events.some((e) => e.kind === 'loop.capped')) {
            return json(402, { error: 'spend_cap', spent_usd: spent, max_usd: r.maxUsd })
          }
        }
        pending.push({ kind, ri: results.length, payload: { run: id, ...rest, body_hash: bodyHash } })
        if (type === 'model_step' && r.maxUsd !== undefined) {
          const p = ev.prices ?? { in: 0, out: 0 }
          spent += (ev.usage.input_tokens * p.in + ev.usage.output_tokens * p.out) / 1e6
          if (spent > r.maxUsd) {
            capped = true
            pending.push({ kind: 'loop.capped', payload: { run: id, after_key: key, spent_usd: spent, max_usd: r.maxUsd } })
          }
        }
        results.push({ type, key, status: 'created', seq: -1 })
      }
      // Commit.
      for (const p of pending) {
        const e = this.append(r, p.kind, p.payload)
        if (p.ri !== undefined) results[p.ri]!.seq = e.seq
      }
      r.spent = spent
      return json(200, { results, ...(capped ? { capped: true } : {}), spent_usd: spent })
    }
    if (!m[3] && method === 'GET') {
      if (!r.events.length) return json(404, { error: 'not_found' })
      const latest = [...r.events].reverse().find((e) => e.kind === 'loop.run_started')
      return json(200, { run: id, epoch: latest?.seq ?? null, events: structuredClone(r.events) })
    }
    return json(404, { error: 'not_found' })
  }
}
