// Local load measurement for keep-your-loop: what one session costs the hosted database. Never touches a real service: it starts
// the hosted server itself (allowlisted env, EXTERNAL_LOOPS=1) against a scratch database on the LOCAL Postgres, and drives it with
// a scripted mock model (no model calls).
//
//   node --experimental-transform-types --no-warnings test/kill/load.ts session --steps 10 --reps 5 --out /tmp/s10.json
//   node ... load.ts session --steps 40 --reps 5 --attr 1 --out ...    # --attr 1: tools run one at a time and every write is bracketed by pg_stat_statements snapshots
//   node ... load.ts growth --out g.json                              # per-write cost against history in the same scope / other scopes
//   node ... load.ts ceiling --limit none|core1|cu025 --out c.json    # closed-loop throughput; core1 = one core (taskset), cu025 = one core at a 25% cfs quota
//   node ... load.ts report a.json b.json ...                         # markdown tables from result files
//
// Needs pg_stat_statements in shared_preload_libraries on the local cluster (and `create extension pg_stat_statements` in the postgres database).
// Environment: HOSTED_DIR (default /home/user/agent-lab/hosted), KT_ADMIN_URL (default postgres://ctx:ctx@localhost:5432/postgres), KT_PORT (default 8791).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateText, jsonSchema, stepCountIs, tool as aiTool } from 'ai'
import * as aiTest from 'ai/test'
import { Argentic } from '../../argentic.ts'
import { durableRun } from '../../ai-sdk.ts'

const args = process.argv.slice(2)
const cmd = args[0]!
const arg = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const HOSTED_DIR = process.env.HOSTED_DIR ?? '/home/user/agent-lab/hosted'
const ROOT = join(HOSTED_DIR, '..')
const ADMIN = process.env.KT_ADMIN_URL ?? 'postgres://ctx:ctx@localhost:5432/postgres'
const PORT = Number(process.env.KT_PORT ?? 8791)
const BASE = `http://localhost:${PORT}`
const dbUrl = (name: string) => ADMIN.replace(/\/[^/]+$/, `/${name}`)
const { connect } = (await import(join(ROOT, 'engine/db.ts'))) as any

const ALLOW = ['PATH', 'HOME', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
const hostedEnv = (db: string) => {
  const env: Record<string, string> = {}
  for (const k of ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]!
  return { ...env, EXTERNAL_LOOPS: '1', PORT: String(PORT), DATABASE_URL: dbUrl(db), LOOP_RATE_PER_MIN: '10000000' } as NodeJS.ProcessEnv
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN }
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN }
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)

// ------------------------------------------------------------ scratch database + hosted server
interface Env { db: string; apiKey: string; server: ChildProcess; pid: number; sql: any; admin: any }
async function freshEnv(db: string, wrap: string[] = []): Promise<Env> {
  const admin = connect(ADMIN, { max: 2 })
  await admin.unsafe(`drop database if exists ${db} with (force)`)
  await admin.unsafe(`create database ${db}`)
  const script = `
    const root = ${JSON.stringify(ROOT)};
    const { connect } = await import(root + '/engine/db.ts');
    const { apply_migrations, load_migrations } = await import(root + '/hosted/src/migrations.ts');
    const sql = connect(${JSON.stringify(dbUrl(db))}, { schema: 'engine', max: 1 });
    await apply_migrations(sql, load_migrations(root));
    await sql.end();`
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: hostedEnv(db) })
  const tenant = `ld-${Date.now().toString(36)}`
  const out = execFileSync(process.execPath, ['scripts/admin.ts', 'tenant', tenant, 'Load', '1000000'], { cwd: HOSTED_DIR, env: hostedEnv(db) }).toString().trim().split('\n').at(-1)!
  if (!out.startsWith('aek_')) throw new Error('no aek_ key from admin.ts tenant')
  const sql = connect(dbUrl(db), { schema: 'engine', max: 2 })
  await sql`update host.tenants set rate_per_min = 10000000 where id = ${tenant}`
  const server = spawn(wrap[0] ?? process.execPath, [...wrap.slice(1), ...(wrap.length ? [process.execPath] : []), 'src/server.ts'], { cwd: HOSTED_DIR, env: hostedEnv(db), stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('hosted server did not report listening')), 30_000)
    server.stdout!.on('data', (d) => { if (String(d).includes('listening')) (clearTimeout(t), res()) })
    server.once('exit', (c) => rej(new Error(`hosted server exited ${c}`)))
  })
  if (!(await fetch(`${BASE}/healthz`)).ok) throw new Error('healthz not ok')
  // With a wrapper (taskset) the child is the wrapper's exec; taskset execs, so the pid is the node process.
  return { db, apiKey: out, server, pid: server.pid!, sql, admin }
}
async function stopEnv(e: Env) {
  e.server.removeAllListeners('exit')
  const gone = new Promise((r) => e.server.once('exit', r))
  e.server.kill('SIGTERM')
  await gone
  await e.sql.end()
  await e.admin.unsafe(`drop database if exists ${e.db} with (force)`)
  await e.admin.end()
}

/** Cumulative on-CPU nanoseconds of a process (all threads), from /proc schedstat. */
function cpuNs(pid: number): number {
  let t = 0
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try { t += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, 'utf8').split(' ')[0]) } catch { /* thread gone */ }
  }
  return t
}
function pgPids(): number[] {
  return execFileSync('pgrep', ['-u', 'postgres'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
}
const pgCpuNs = () => pgPids().reduce((a, p) => { try { return a + cpuNs(p) } catch { return a } }, 0)

// ------------------------------------------------------------ pg_stat_statements snapshots
type Stmt = { q: string; calls: number; ms: number; rows: number }
async function snap(admin: any, db: string): Promise<Map<string, Stmt>> {
  const r = await admin.unsafe(
    `select queryid::text id, left(regexp_replace(query, '\\s+', ' ', 'g'), 150) q, calls::int calls, (total_exec_time + coalesce(total_plan_time, 0)) ms, rows::int rows
     from pg_stat_statements where dbid = (select oid from pg_database where datname = $1)`, [db])
  return new Map(r.map((x: any) => [x.id, { q: x.q, calls: x.calls, ms: Number(x.ms), rows: x.rows }]))
}
type Delta = { calls: number; ms: number; by: Map<string, Stmt> }
function diff(a: Map<string, Stmt>, b: Map<string, Stmt>): Delta {
  const by = new Map<string, Stmt>()
  let calls = 0, ms = 0
  for (const [id, s] of b) {
    const p = a.get(id)
    const c = s.calls - (p?.calls ?? 0), m = s.ms - (p?.ms ?? 0)
    if (c > 0) { by.set(id, { q: s.q, calls: c, ms: m, rows: s.rows - (p?.rows ?? 0) }); calls += c; ms += m }
  }
  return { calls, ms, by }
}

// ------------------------------------------------------------ the scripted session
const VOCAB = 'account invoice customer plan renewal seat usage region limit status owner amount refund ticket policy contract discount period balance credit meter product workspace member admin billing address contact vendor order shipment warranty quote lead stage pipeline forecast risk audit export report summary trend churn upgrade downgrade trial coupon tax currency payment method failed retry webhook event key token scope role access'.split(' ')
function words(seed: number, chars: number): string {
  let x = seed * 2654435761 % 4294967296 || 1
  let s = ''
  while (s.length < chars) { x = (x * 1103515245 + 12345) % 2147483648; s += VOCAB[x % VOCAB.length] + (x % 11 === 0 ? '. ' : ' ') }
  return s.slice(0, chars)
}
const SYSTEM = words(7, 1024)
const PROMPT = 'Work through the account review. Use the tools, then summarise in two sentences.'
const resultSize = (step: number, j: number) => 500 + ((step * 7 + j * 13) % 4) * 500 // 500, 1000, 1500, 2000 bytes

const { MockLanguageModelV4 } = aiTest as any
const usageOf = (prompt: any[], out: number) => ({ inputTokens: { total: Math.ceil(JSON.stringify(prompt).length / 4), noCache: Math.ceil(JSON.stringify(prompt).length / 4), cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: out, text: out, reasoning: 0 } })

interface Marks { atStep: (k: number) => Promise<void> }
function scriptedModel(steps: number, marks: Marks) {
  return new MockLanguageModelV4({
    provider: 'scripted', modelId: 'scripted-1',
    doGenerate: async (o: any) => {
      const done = o.prompt.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content.filter((p: any) => p.type === 'tool-result')).length
      const k = Math.floor(done / 2)
      await marks.atStep(k)
      if (k < steps - 1) {
        return {
          content: [0, 1].map((j) => ({ type: 'tool-call' as const, toolCallId: `call_${k}_${j}`, toolName: j === 0 ? 'search' : 'fetch_doc', input: JSON.stringify({ query: words(k * 2 + j, 40) }) })),
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usageOf(o.prompt, 60), warnings: [],
        }
      }
      return { content: [{ type: 'text' as const, text: words(99, 300) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(o.prompt, 80), warnings: [] }
    },
  })
}

interface W { route: string; kind: string; step: number | 'open' | 'fin' | 'get'; ms: number; reqBytes: number; resBytes: number; status: number; cpuNs?: number; dbCalls?: number; dbMs?: number; by?: [string, Stmt][] }
interface StepRow { step: number | 'open'; dbMs: number; dbCalls: number; nodeCpuMs: number; pgCpuMs: number; wallMs: number }
interface SessionResult {
  steps: number; attr: boolean; reps: number
  requests: { total: number; byRoute: Record<string, number>; byKind: Record<string, number> }
  writes: W[]; perStep: StepRow[]
  totals: { dbMs: number; dbCalls: number; nodeCpuMs: number; pgCpuMs: number; wallMs: number }
  stmts: [string, Stmt][]
  events: { rows: number; rowBytes: number; payloadBytes: number; byKind: Record<string, { rows: number; payloadBytes: number }>; relBytes: number; heapBytes: number; idxBytes: number; relBytesBefore: number; walBytes: number; tables: Record<string, number> }
  reply: string
}

const stepOfKey = (key: string | undefined) => (key && /^m(\d+)/.exec(key) ? Number(/^m(\d+)/.exec(key)![1]) : -1)

async function oneSession(env: Env, o: { steps: number; attr: boolean; agent: string; run: string; capture?: any[] }): Promise<SessionResult> {
  const writes: W[] = []
  const T = (kind: string, step: W['step']) => ({ kind, step })
  const snapTotals = async () => ({ s: await snap(env.admin, env.db), cpu: cpuNs(env.pid), pg: pgCpuNs(), t: performance.now() })
  const timedFetch: typeof fetch = async (url, init) => {
    const path = String(url)
    const isWrite = init?.method === 'POST' && /\/runs\/[^/]+\/(open|events)$/.test(path)
    let kind = path.endsWith('/open') ? 'open' : init?.method === 'GET' ? 'get' : '?'
    let step: W['step'] = kind === 'open' ? 'open' : 'get'
    if (path.endsWith('/events')) {
      const body = JSON.parse(String(init!.body))
      kind = body.events[0].type
      step = kind === 'run_finished' ? 'fin' : stepOfKey(body.events[0].key)
      if (o.capture) o.capture.push(body.events[0])
    }
    const before = o.attr ? await snapTotals() : undefined
    const c0 = cpuNs(env.pid)
    const t0 = performance.now()
    const res = await fetch(url, init)
    const text = await res.clone().text()
    const ms = performance.now() - t0
    const c1 = cpuNs(env.pid)
    const w: W = { route: `${init?.method ?? 'GET'} ${path.replace(BASE, '').replace(/\/agents\/[^/]+\/runs\/[^/]+/, '/agents/:a/runs/:r')}`, ...T(kind, step), ms, reqBytes: init?.body ? Buffer.byteLength(String(init.body)) : 0, resBytes: Buffer.byteLength(text), status: res.status, cpuNs: c1 - c0 }
    if (before) {
      const after = await snapTotals()
      const d = diff(before.s, after.s)
      w.dbCalls = d.calls; w.dbMs = d.ms; w.by = [...d.by]
    }
    void isWrite
    writes.push(w)
    return res
  }

  const walStart = (await env.sql`select pg_current_wal_lsn()::text l`)[0].l as string
  const relBefore = Number((await env.sql`select pg_total_relation_size('engine.events') n`)[0].n)
  const tabBefore = await tableInserts(env)
  await env.admin.unsafe('select pg_stat_statements_reset()')
  const start = await snapTotals()
  const boundaries: { step: number; s: Map<string, Stmt>; cpu: number; pg: number; t: number }[] = []
  const marks: Marks = { atStep: async (k) => { const b = await snapTotals(); boundaries.push({ step: k, ...b }) } }

  const client = new Argentic({ apiKey: env.apiKey, baseUrl: BASE, fetch: timedFetch, writeDeadlineMs: 20_000 })
  const run = await durableRun(client, { agent: o.agent, runId: o.run, process: `load:${process.pid}` })
  const mk = (name: string, j: number) =>
    aiTool({
      description: `${name}: read-only lookup.`,
      inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
      execute: async (_i: any, opts: any) => {
        const k = Number(/call_(\d+)_/.exec(opts.toolCallId)?.[1] ?? 0)
        return { text: words(1000 + k * 2 + j, resultSize(k, j)) }
      },
    } as any)
  let tools: any = run.tools({ search: mk('search', 0), fetch_doc: mk('fetch_doc', 1) })
  if (o.attr) {
    let chain: Promise<unknown> = Promise.resolve()
    for (const [n, t] of Object.entries<any>(tools)) {
      const ex = t.execute
      tools[n] = { ...t, execute: (i: any, op: any) => { const p = chain.then(() => ex(i, op), () => ex(i, op)); chain = p.catch(() => {}); return p } }
    }
  }
  const r = await generateText({ model: run.model(scriptedModel(o.steps, marks)), tools, stopWhen: stepCountIs(o.steps + 3), system: SYSTEM, prompt: PROMPT, maxRetries: 0 } as any)
  await run.finish({ reply: r.text })
  const end = await snapTotals()

  const perStep: StepRow[] = []
  const pts = [{ step: 'open' as const, ...start }, ...boundaries.map((b) => ({ ...b })), { step: -1, ...end }]
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const d = diff(a.s, b.s)
    perStep.push({ step: a.step === 'open' ? 'open' : (a.step as number), dbMs: d.ms, dbCalls: d.calls, nodeCpuMs: (b.cpu - a.cpu) / 1e6, pgCpuMs: (b.pg - a.pg) / 1e6, wallMs: b.t - a.t })
  }
  const total = diff(start.s, end.s)
  // The per-step table is bracketed: 'open' is the open call plus the journal read; step k is model_step k, its tool writes, and (last step) run_finished.
  const stmts: [string, Stmt][] = [...total.by].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)

  await new Promise((r) => setTimeout(r, 1500)) // pg_stat_user_tables flushes counters lazily
  const stat = (await env.sql`
    select count(*)::int rows, coalesce(sum(pg_column_size(e.*)),0)::int8 row_bytes, coalesce(sum(pg_column_size(payload)),0)::int8 payload_bytes from engine.events e where payload->>'run' = ${o.run}`)[0]
  const byKind = await env.sql`select kind, count(*)::int rows, sum(pg_column_size(payload))::int8 pb from engine.events where payload->>'run' = ${o.run} group by kind order by kind`
  const rel = (await env.sql`select pg_total_relation_size('engine.events') t, pg_relation_size('engine.events') h, pg_indexes_size('engine.events') i`)[0]
  const walEnd = (await env.sql`select pg_wal_lsn_diff(pg_current_wal_lsn(), ${walStart}::pg_lsn)::int8 d`)[0].d
  const tabAfter = await tableInserts(env)
  const tables: Record<string, number> = {}
  for (const [k, v] of Object.entries(tabAfter)) if (v - (tabBefore[k] ?? 0) > 0) tables[k] = v - (tabBefore[k] ?? 0)

  const byRoute: Record<string, number> = {}, byKind2: Record<string, number> = {}
  for (const w of writes) { byRoute[w.route] = (byRoute[w.route] ?? 0) + 1; byKind2[w.kind] = (byKind2[w.kind] ?? 0) + 1 }
  return {
    steps: o.steps, attr: o.attr, reps: 1,
    requests: { total: writes.length, byRoute, byKind: byKind2 },
    writes, perStep,
    totals: { dbMs: total.ms, dbCalls: total.calls, nodeCpuMs: (end.cpu - start.cpu) / 1e6, pgCpuMs: (end.pg - start.pg) / 1e6, wallMs: end.t - start.t },
    stmts,
    events: {
      rows: Number(stat.rows), rowBytes: Number(stat.row_bytes), payloadBytes: Number(stat.payload_bytes),
      byKind: Object.fromEntries(byKind.map((k: any) => [k.kind, { rows: Number(k.rows), payloadBytes: Number(k.pb) }])),
      relBytes: Number(rel.t), heapBytes: Number(rel.h), idxBytes: Number(rel.i), relBytesBefore: relBefore, walBytes: Number(walEnd), tables,
    },
    reply: r.text.slice(0, 40),
  }
}
async function tableInserts(env: Env): Promise<Record<string, number>> {
  const r = await env.sql`select schemaname || '.' || relname t, (n_tup_ins + n_tup_upd)::int8 n from pg_stat_user_tables`
  return Object.fromEntries(r.map((x: any) => [x.t, Number(x.n)]))
}

/** Warm the server (JIT, pool, plans) on a different agent, so the measured session is not the process's first. */
async function warm(env: Env) {
  const client = new Argentic({ apiKey: env.apiKey, baseUrl: BASE, writeDeadlineMs: 20_000 })
  const run = await durableRun(client, { agent: 'warmup', runId: 'w1', process: 'warm' })
  const t: any = run.tools({ search: aiTool({ description: 'x', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => ({ text: 'ok' }) } as any) })
  const r = await generateText({ model: run.model(scriptedModel(3, { atStep: async () => {} })), tools: t, stopWhen: stepCountIs(6), system: SYSTEM, prompt: PROMPT, maxRetries: 0 } as any)
  await run.finish({ reply: r.text })
}

// ------------------------------------------------------------ session
async function cmdSession() {
  const steps = Number(arg('steps', '10')), reps = Number(arg('reps', '5')), attr = arg('attr', '0') === '1', out = arg('out')!
  const results: SessionResult[] = []
  for (let i = 0; i < reps; i++) {
    const env = await freshEnv(`loops_load_s${steps}_${i}`)
    try {
      await warm(env)
      const res = await oneSession(env, { steps, attr, agent: 'agent-a', run: `run-${i}` })
      results.push(res)
      console.log(`rep ${i}: ${res.requests.total} requests, db ${res.totals.dbMs.toFixed(1)} ms / ${res.totals.dbCalls} stmts, node cpu ${res.totals.nodeCpuMs.toFixed(0)} ms, events ${res.events.rows}`)
    } finally { await stopEnv(env) }
  }
  writeFileSync(out, JSON.stringify({ kind: 'session', steps, attr, results }))
}

// ------------------------------------------------------------ raw replay (growth + ceiling)
async function template(steps = 10): Promise<any[]> {
  const env = await freshEnv('loops_load_tpl')
  try {
    await warm(env)
    const cap: any[] = []
    await oneSession(env, { steps, attr: false, agent: 'tpl', run: 'tpl', capture: cap })
    return cap
  } finally { await stopEnv(env) }
}
async function post(env: { apiKey: string }, path: string, body: unknown): Promise<{ ms: number; status: number; json: any }> {
  const t0 = performance.now()
  const res = await fetch(BASE + path, { method: 'POST', headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => null)
  return { ms: performance.now() - t0, status: res.status, json }
}
/** Replays the captured events as a fresh run; returns each write's latency. Open counts as a write. */
async function replay(env: { apiKey: string }, tpl: any[], agent: string, run: string): Promise<{ kind: string; step: number; ms: number; status: number }[]> {
  const base = `/v1/agents/${agent}/runs/${run}`
  const out: { kind: string; step: number; ms: number; status: number }[] = []
  const o = await post(env, `${base}/open`, { process: 'replay' })
  out.push({ kind: 'open', step: -1, ms: o.ms, status: o.status })
  if (o.status !== 200) return out
  const epoch = o.json.epoch
  for (const ev of tpl) {
    const r = await post(env, `${base}/events`, { epoch, events: [ev] })
    out.push({ kind: ev.type, step: stepOfKey(ev.key), ms: r.ms, status: r.status })
    if (r.status !== 200) break
  }
  return out
}

const ROWS_OF = (scope: string, run: string) =>
  `select seq::int8 as seq, kind, coalesce(payload->>'key', 'run') as key, payload->>'body_hash' as bh,
          case when kind in ('loop.run_started', 'loop.model_step', 'loop.capped') then payload - 'response' - 'request_delta' else null end as p
   from events where scope = '${scope}' and kind like 'loop.%' and payload->>'run' = '${run}' order by seq`

// ------------------------------------------------------------ growth
async function cmdGrowth() {
  const out = arg('out')!
  const tpl = await template(10)
  const nEv = tpl.length + 1
  const rows: any[] = []
  const explains: Record<string, string> = {}
  for (const layout of ['same_scope', 'other_scopes'] as const) {
    for (const K of [0, 100, 500, 2000]) {
      if (K === 0 && layout === 'other_scopes') continue
      const env = await freshEnv('loops_load_g')
      try {
        await warm(env)
        // preload K finished sessions, 6 at a time
        let next = 0
        const pre = async () => { for (;;) { const i = next++; if (i >= K) return; await replay(env, tpl, layout === 'same_scope' ? 'hist' : `h${i}`, `p${i}`) } }
        await Promise.all(Array.from({ length: 6 }, pre))
        await env.sql`analyze engine.events`
        await new Promise((r) => setTimeout(r, 300))
        await env.admin.unsafe('select pg_stat_statements_reset()')
        const s0 = await snap(env.admin, env.db)
        const lat: { kind: string; step: number; ms: number }[] = []
        for (let i = 0; i < 20; i++) lat.push(...(await replay(env, tpl, layout === 'same_scope' ? 'hist' : 'probe', `m${i}`)))
        const s1 = await snap(env.admin, env.db)
        const d = diff(s0, s1)
        const evRows = Number((await env.sql`select count(*)::int n from engine.events`)[0].n)
        const rel = Number((await env.sql`select pg_total_relation_size('engine.events') n`)[0].n)
        const writes = lat.length
        const by = (f: (x: any) => boolean) => lat.filter(f).map((x) => x.ms)
        rows.push({
          layout, K, events: evRows, relBytes: rel, writes, dbMsPerWrite: d.ms / writes, dbCallsPerWrite: d.calls / writes,
          medMs: med(lat.map((x) => x.ms)), p95Ms: pct(lat.map((x) => x.ms), 0.95),
          medStep0: med(by((x) => x.step === 0 && x.kind === 'tool_finished')), medStep9: med(by((x) => x.step === 9 && x.kind === 'tool_finished')),
          medModelStep0: med(by((x) => x.kind === 'model_step' && x.step === 0)), medModelStep9: med(by((x) => x.kind === 'model_step' && x.step === 9)),
        })
        console.log(JSON.stringify(rows.at(-1)))
        if (K === 0 || K === 2000) {
          const scope = (await env.sql`select scope from engine.events where kind like 'loop.%' and payload->>'run' = 'm0' limit 1`)[0].scope as string
          const ex = await env.sql.unsafe(`explain (analyze, buffers, costs on) ${ROWS_OF(scope, 'm0')}`)
          explains[`${layout}_K${K}`] = ex.map((x: any) => x['QUERY PLAN']).join('\n')
        }
      } finally { await stopEnv(env) }
    }
  }
  writeFileSync(out, JSON.stringify({ kind: 'growth', eventsPerSession: nEv, rows, explains }))
}

// ------------------------------------------------------------ ceiling
function limitSetup(limit: string, env: Env): () => void {
  const cg = '/sys/fs/cgroup/cpu/ld'
  const pids = [...pgPids(), env.pid]
  if (limit === 'none') return () => {}
  for (const p of pids) { try { execFileSync('taskset', ['-a', '-cp', '0', String(p)], { stdio: 'ignore' }) } catch { /* exited */ } }
  if (limit === 'cu025') {
    execFileSync('sh', ['-c', `mkdir -p ${cg} && echo 100000 > ${cg}/cpu.cfs_period_us && echo 25000 > ${cg}/cpu.cfs_quota_us`])
    for (const p of pids) { try { writeFileSync(`${cg}/cgroup.procs`, String(p)) } catch { /* exited */ } }
  }
  return () => {
    for (const p of pgPids().concat(env.pid)) {
      try { writeFileSync('/sys/fs/cgroup/cpu/cgroup.procs', String(p)) } catch { /* ignore */ }
      try { execFileSync('taskset', ['-a', '-cp', '0-' + (Number(execFileSync('nproc', { encoding: 'utf8' })) - 1), String(p)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }
}
async function cmdCeiling() {
  const limit = arg('limit', 'none')!, out = arg('out')!, secs = Number(arg('secs', '12'))
  const tpl = JSON.parse(readFileSync(arg('tpl', '/tmp/loop_template.json')!, 'utf8')) as any[]
  const env = await freshEnv(`loops_load_c_${limit}`)
  const restore = limitSetup(limit, env)
  const levels: any[] = []
  try {
    await warm(env)
    let base = NaN
    for (const C of [1, 2, 4, 8, 16, 32, 64]) {
      const lat: number[] = [], errs: Record<number, number> = {}
      let stop = false, n = 0
      const t0 = performance.now()
      const cpu0 = cpuNs(env.pid), pg0 = pgCpuNs()
      const worker = async (w: number) => {
        while (!stop) {
          const r = await replay(env, tpl, `c${C}w${w}s${n++}`, 'r')
          for (const x of r) { if (performance.now() - t0 > 2000) lat.push(x.ms); if (x.status !== 200) errs[x.status] = (errs[x.status] ?? 0) + 1 }
        }
      }
      const ws = Array.from({ length: C }, (_, w) => worker(w))
      await new Promise((r) => setTimeout(r, secs * 1000))
      stop = true
      await Promise.all(ws)
      const elapsed = (performance.now() - t0) / 1000
      const cpuS = (cpuNs(env.pid) - cpu0) / 1e9, pgS = (pgCpuNs() - pg0) / 1e9
      const measured = elapsed - 2
      const row = { C, writes: lat.length, perSec: lat.length / measured, medMs: med(lat), p95Ms: pct(lat, 0.95), p99Ms: pct(lat, 0.99), errs, nodeCpuCores: cpuS / elapsed, pgCpuCores: pgS / elapsed }
      if (C === 1) base = row.medMs
      levels.push(row)
      console.log(JSON.stringify(row))
      if (row.medMs >= 2 * base && C > 1) { if (levels.filter((l) => l.medMs >= 2 * base).length >= 2) break }
    }
  } finally { restore(); await stopEnv(env) }
  writeFileSync(out, JSON.stringify({ kind: 'ceiling', limit, levels }))
}


// ------------------------------------------------------------ indexcheck: does a (scope, run) index fix the growth? Experiment only, on the scratch DB; nothing in hosted/ changes.
async function cmdIndexCheck() {
  const out = arg('out')!, K = Number(arg('k', '500'))
  const tpl = JSON.parse(readFileSync(arg('tpl', '/tmp/loop_template.json')!, 'utf8')) as any[]
  const env = await freshEnv('loops_load_ix')
  const res: any = { K }
  try {
    await warm(env)
    let next = 0
    const pre = async () => { for (;;) { const i = next++; if (i >= K) return; await replay(env, tpl, 'hist', `p${i}`) } }
    await Promise.all(Array.from({ length: 6 }, pre))
    const probe = async (label: string) => {
      await env.sql`analyze engine.events`
      await env.admin.unsafe('select pg_stat_statements_reset()')
      const s0 = await snap(env.admin, env.db)
      const lat: number[] = []
      for (let i = 0; i < 20; i++) lat.push(...(await replay(env, tpl, 'hist', `${label}${i}`)).map((x) => x.ms))
      const d = diff(s0, await snap(env.admin, env.db))
      const scope = (await env.sql`select scope from engine.events where payload->>'run' = ${label + '0'} limit 1`)[0].scope as string
      const ex = await env.sql.unsafe(`explain (analyze, buffers) ${ROWS_OF(scope, label + '0')}`)
      res[label] = { medMs: med(lat), p95Ms: pct(lat, 0.95), dbMsPerWrite: d.ms / lat.length, plan: ex.map((x: any) => x['QUERY PLAN']).join('\n') }
      console.log(label, JSON.stringify({ ...res[label], plan: undefined }))
    }
    await probe('before')
    await env.sql.unsafe(`create index events_loop_run on events (scope, (payload->>'run'), seq) where kind like 'loop.%'`)
    await probe('after')
    res.indexBytes = Number((await env.sql`select pg_relation_size('engine.events_loop_run') n`)[0].n)
  } finally { await stopEnv(env) }
  writeFileSync(out, JSON.stringify({ kind: 'indexcheck', ...res }))
}

// ------------------------------------------------------------ report
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
function cmdReport() {
  const files = args.slice(1).map((p) => JSON.parse(readFileSync(p, 'utf8')))
  for (const j of files) {
    if (j.kind === 'session') {
      const R: SessionResult[] = j.results
      console.log(`\n### session: ${j.steps} steps, ${j.attr ? 'attributed (serial tools, per-write snapshots)' : 'natural (SDK parallel tools)'}, ${R.length} reps (median [min-max])`)
      const m = (g: (r: SessionResult) => number, d = 1) => `${f(med(R.map(g)), d)} [${f(Math.min(...R.map(g)), d)}-${f(Math.max(...R.map(g)), d)}]`
      console.log(`| metric | per session | per model step |\n|---|---|---|`)
      const rows: [string, (r: SessionResult) => number, number][] = [
        ['HTTP requests to hosted', (r) => r.requests.total, 1], ['Postgres statements (calls)', (r) => r.totals.dbCalls, 0], ['DB time, sum of exec time (ms)', (r) => r.totals.dbMs, 1],
        ['hosted node CPU (ms)', (r) => r.totals.nodeCpuMs, 0], ['postgres CPU, all backends (ms)', (r) => r.totals.pgCpuMs, 0], ['wall time (ms)', (r) => r.totals.wallMs, 0],
        ['events rows added', (r) => r.events.rows, 0], ['events row bytes (pg_column_size(e.*))', (r) => r.events.rowBytes, 0], ['events payload bytes (pg_column_size)', (r) => r.events.payloadBytes, 0],
        ['events relation growth incl. indexes (bytes, 8 KB pages)', (r) => r.events.relBytes - r.events.relBytesBefore, 0], ['WAL written (bytes)', (r) => r.events.walBytes, 0],
      ]
      for (const [name, g, d] of rows) console.log(`| ${name} | ${m(g, d)} | ${f(med(R.map(g)) / j.steps, d === 0 ? 1 : 2)} |`)
      console.log(`\nrequests by route (median): ${Object.entries(R[0]!.requests.byRoute).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
      console.log(`requests by kind (rep 0): ${Object.entries(R[0]!.requests.byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      console.log(`events by kind (rep 0): ${Object.entries(R[0]!.events.byKind).map(([k, v]) => `${k}: ${v.rows} rows ${v.payloadBytes} B`).join('; ')}`)
      console.log(`tables written (rows ins+upd, rep 0): ${Object.entries(R[0]!.events.tables).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      // per-step DB time curve
      const idx = [0, 1, 4, 9, 19, 29, 39].filter((i) => i < j.steps)
      console.log(`\nper-step DB time ms / statements / node CPU ms (median over reps), step index: ` + idx.map((i) => `s${i}`).join(' '))
      console.log(`| step | ` + idx.map((i) => i + 1).join(' | ') + ` |\n|---|` + idx.map(() => '---').join('|') + '|')
      const ps = (g: (s: StepRow) => number, d: number) => idx.map((i) => f(med(R.map((r) => g(r.perStep.find((s) => s.step === i)!))), d))
      console.log(`| DB ms | ${ps((s) => s.dbMs, 2).join(' | ')} |`)
      console.log(`| statements | ${ps((s) => s.dbCalls, 0).join(' | ')} |`)
      console.log(`| node CPU ms | ${ps((s) => s.nodeCpuMs, 1).join(' | ')} |`)
      console.log(`| wall ms | ${ps((s) => s.wallMs, 1).join(' | ')} |`)
      const o = R.map((r) => r.perStep.find((s) => s.step === 'open')!)
      console.log(`open + journal read: DB ${f(med(o.map((s) => s.dbMs)), 2)} ms, ${f(med(o.map((s) => s.dbCalls)), 0)} stmts, node cpu ${f(med(o.map((s) => s.nodeCpuMs)), 1)} ms`)
      // write latency by kind (client round trip) and, in attr mode, db stats per kind
      const kinds = ['open', 'model_step', 'tool_started', 'tool_finished', 'run_finished']
      console.log(`\n| write kind | n/session | round trip ms med | p95 | request B | response B |${j.attr ? ' stmts/req | DB ms/req | node CPU ms/req |' : ' node CPU ms/req |'}\n|---|---|---|---|---|---|${j.attr ? '---|---|---|' : '---|'}`)
      for (const k of kinds) {
        const ws = R.flatMap((r) => r.writes.filter((w) => w.kind === k && w.status === 200))
        if (!ws.length) continue
        console.log(`| ${k} | ${f(ws.length / R.length, 1)} | ${f(med(ws.map((w) => w.ms)), 1)} | ${f(pct(ws.map((w) => w.ms), 0.95), 1)} | ${f(mean(ws.map((w) => w.reqBytes)), 0)} | ${f(mean(ws.map((w) => w.resBytes)), 0)} |${j.attr ? ` ${f(mean(ws.map((w) => w.dbCalls!)), 1)} | ${f(mean(ws.map((w) => w.dbMs!)), 2)} | ${f(mean(ws.map((w) => w.cpuNs! / 1e6)), 2)} |` : ` ${f(mean(ws.map((w) => w.cpuNs! / 1e6)), 2)} |`}`)
      }
      if (j.attr) {
        console.log(`\nper-write DB ms for model_step / tool_started / tool_finished by step (mean over reps)`)
        const sidx = [0, 1, 4, 9, 19, 29, 39].filter((i) => i < j.steps)
        console.log(`| kind | ` + sidx.map((i) => 'step ' + (i + 1)).join(' | ') + ` |\n|---|` + sidx.map(() => '---').join('|') + '|')
        for (const k of ['model_step', 'tool_started', 'tool_finished']) {
          console.log(`| ${k} | ` + sidx.map((i) => f(mean(R.flatMap((r) => r.writes.filter((w) => w.kind === k && w.step === i).map((w) => w.dbMs!))), 2)).join(' | ') + ' |')
        }
        console.log(`| (statements) | ` + sidx.map((i) => f(mean(R.flatMap((r) => r.writes.filter((w) => w.kind === 'tool_finished' && w.step === i).map((w) => w.dbCalls!))), 1)).join(' | ') + ' | <- tool_finished statements/req')
      }
      console.log(`\ntop statements by total exec time (rep 0), calls / total ms:`)
      for (const [, s] of R[0]!.stmts.slice(0, 14)) console.log(`- ${s.calls} calls, ${f(s.ms, 2)} ms (${f(s.ms / s.calls, 3)} ms/call): \`${s.q}\``)
    } else if (j.kind === 'growth') {
      console.log(`\n### growth (replay of a ${j.eventsPerSession}-write 10-step session; 20 probe runs per row)`)
      console.log(`| history | prior sessions | events rows | events size MB | DB ms/write | stmts/write | median ms | p95 ms | model_step write 1 ms | model_step write 10 ms |\n|---|---|---|---|---|---|---|---|---|---|`)
      for (const r of j.rows) console.log(`| ${r.layout} | ${r.K} | ${r.events} | ${f(r.relBytes / 1e6, 1)} | ${f(r.dbMsPerWrite, 2)} | ${f(r.dbCallsPerWrite, 1)} | ${f(r.medMs, 1)} | ${f(r.p95Ms, 1)} | ${f(r.medModelStep0, 1)} | ${f(r.medModelStep9, 1)} |`)
      for (const [k, v] of Object.entries<string>(j.explains)) console.log(`\n#### EXPLAIN ANALYZE rows_of, ${k}\n\`\`\`\n${v}\n\`\`\``)
    } else if (j.kind === 'ceiling') {
      console.log(`\n### ceiling, limit=${j.limit}`)
      console.log(`| concurrent sessions | writes/s | median ms | p95 ms | p99 ms | node CPU cores | postgres CPU cores | errors |\n|---|---|---|---|---|---|---|---|`)
      for (const r of j.levels) console.log(`| ${r.C} | ${f(r.perSec, 1)} | ${f(r.medMs, 1)} | ${f(r.p95Ms, 1)} | ${f(r.p99Ms, 1)} | ${f(r.nodeCpuCores, 2)} | ${f(r.pgCpuCores, 2)} | ${JSON.stringify(r.errs)} |`)
    }
  }
}

// ------------------------------------------------------------ template (for ceiling)
async function cmdTemplate() { writeFileSync(arg('out', '/tmp/loop_template.json')!, JSON.stringify(await template(Number(arg('steps', '10'))))) }

const main = { indexcheck: cmdIndexCheck, session: cmdSession, growth: cmdGrowth, ceiling: cmdCeiling, report: cmdReport, template: cmdTemplate }[cmd as 'session']
if (!main) { console.error('usage: load.ts session|growth|ceiling|template|indexcheck|report'); process.exit(2) }
await main()
process.exit(0)
void existsSync
