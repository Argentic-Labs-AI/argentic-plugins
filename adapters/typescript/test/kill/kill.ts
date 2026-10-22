// Kill test for the client's durableRun ("keep your loop"). It talks only to Argentic's public HTTP API, through the client:
// agent.ts is run as a child process, SIGKILLed at a named point and started again with the same runId, and this script reads the run's
// journal back over HTTP (GET /v1/agents/:agent/runs/:run) to check what was recorded and what ran.
//
//   export ARGENTIC_BASE_URL=https://api.getargentic.com      # or a local server
//   export ARGENTIC_API_KEY=aek_...                            # an account with "keep your loop" turned on
//   cd adapters/typescript/test/kill && npm install            # once; only live mode and case 6b need @ai-sdk/openai-compatible
//   cd ../.. && node --experimental-transform-types --no-warnings test/kill/kill.ts [--mode scripted|live|both] [--cases 1,2,3] [--out file.md]
//
// Scripted mode (default) needs no model key: the model is a script that plays the same story on every start. Live mode is opt-in:
// --mode live, with NV_API_KEY set (never printed, never written). Live mode runs cases 1, 3, 4 and 5 only, one request in flight,
// >= 2 s between model calls, at most 60 calls in total.
//
// The test writes a few hundred requests under agents named kt-*. Use a test account. A per-minute request limit on the key makes the
// run slower, not wrong: the client waits out a 429 and so does the journal read below. Exit code 0 only if every case that ran passed;
// 2 means the test could not start (missing variables, bad key, keep your loop not turned on).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Argentic } from '../../argentic.ts'
import type { Cfg } from './agent.ts'

const args = process.argv.slice(2)
const arg = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const MODES = arg('mode', 'scripted') === 'both' ? ['scripted', 'live'] : [arg('mode', 'scripted')!]
const ONLY = arg('cases') ? new Set(arg('cases')!.split(',')) : undefined
const OUT = arg('out')
const BASE = (process.env.ARGENTIC_BASE_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.ARGENTIC_API_KEY ?? ''
const here = import.meta.dirname
const work = mkdtempSync(join(tmpdir(), 'kill-test-'))
const stamp = Date.now().toString(36)
const NODE = [process.execPath, '--experimental-transform-types', '--no-warnings']
const secret = process.env.NV_API_KEY
const scrub = (s: string) => {
  let out = s
  for (const v of [secret, apiKey]) if (v) out = out.replaceAll(v, '***')
  return out
}

/** Fails early, with a reason, if the key does not work or keep your loop is not on for the account. Uses the client's own open call. */
async function preflight(): Promise<string | undefined> {
  try {
    const client = new Argentic({ apiKey, baseUrl: BASE })
    await client.postJson(`/v1/agents/kt-preflight/runs/pre-${stamp}/open`, { process: 'preflight' }, { deadlineMs: 30_000 })
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) return `the API key was refused (HTTP ${e.status})`
    if (e?.status === 404) return 'keep your loop is not turned on for this account (opening a run answered 404)'
    return `could not open a run at ${BASE}: ${String(e?.message ?? e)}`
  }
  return undefined
}

// ---------------------------------------------------------------- journal
interface Ev { seq: number; at: string; kind: string; payload: any }
async function journal(agent: string, run: string): Promise<Ev[]> {
  for (let waited = 0; ; ) {
    const r = await fetch(`${BASE}/v1/agents/${agent}/runs/${run}`, { headers: { authorization: `Bearer ${apiKey}` } })
    if (r.status === 404) return []
    if (r.status === 429 && waited < 300_000) {
      const info = (await r.json().catch(() => ({}))) as { retry_after?: number }
      const ms = Math.min(Math.max(info.retry_after ?? Number(r.headers.get('retry-after') ?? 2), 1), 30) * 1000
      waited += ms
      await new Promise((res) => setTimeout(res, ms))
      continue
    }
    if (!r.ok) throw new Error(`journal ${r.status}`)
    return ((await r.json()) as any).events
  }
}
const short = (e: Ev) => {
  const p = e.payload ?? {}
  const k = e.kind.replace('loop.', '')
  if (k === 'run_started') return `run_started(epoch ${p.epoch})`
  if (k === 'run_finished') return 'run_finished'
  if (k === 'tool_started') return `tool_started(${p.key} ${p.tool})`
  if (k === 'tool_finished') return `tool_finished(${p.key} ${p.outcome})`
  return `${k}(${p.key})`
}
const summary = (evs: Ev[]) => evs.map(short).join(' > ')
const has = (evs: Ev[], kind: string, f: (p: any) => boolean = () => true) => evs.some((e) => e.kind === `loop.${kind}` && f(e.payload))
const work_events = (evs: Ev[]) => evs.filter((e) => e.kind !== 'loop.run_started').length
const count = (evs: Ev[], kind: string) => evs.filter((e) => e.kind === `loop.${kind}`).length
const stepsOf = (evs: Ev[]) => evs.filter((e) => e.kind === 'loop.model_step').map((e) => `${e.payload.key}:${e.payload.request_hash.slice(0, 8)}`)

// ---------------------------------------------------------------- children
interface Done { ok: boolean; text?: string; error?: { name: string; message: string; status?: number }; stats: { providerAttempts: number; toolRuns: { lookup: number; charge: number }; charges: string[]; writes: { kind: string; ms: number }[] } }
class Child {
  lines: string[] = []
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private proc: ChildProcess
  private waiters: { name: string; res: () => void }[] = []
  constructor(cfg: Cfg) {
    const env = { ...process.env, KT_CFG: JSON.stringify(cfg), ARGENTIC_BASE_URL: BASE, ARGENTIC_API_KEY: apiKey } as NodeJS.ProcessEnv
    if (cfg.mode === 'scripted') delete env.NV_API_KEY
    this.proc = spawn(NODE[0]!, [...NODE.slice(1), join(here, 'agent.ts')], { cwd: here, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    this.proc.stdout!.on('data', (d) => {
      buf += String(d)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = scrub(buf.slice(0, i))
        buf = buf.slice(i + 1)
        this.lines.push(line)
        for (const w of this.waiters.filter((w) => line === `@@AT ${w.name}`)) w.res()
      }
    })
    this.proc.stderr!.on('data', (d) => this.lines.push('[stderr] ' + scrub(String(d)).trimEnd()))
    this.exited = new Promise((res) => this.proc.once('exit', (code, signal) => res({ code, signal })))
  }
  /** Resolves when the child reports the point; rejects if it exits first or the time runs out. */
  waitAt(name: string, ms = 240_000): Promise<void> {
    return new Promise((res, rej) => {
      if (this.lines.includes(`@@AT ${name}`)) return res()
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${name}\n${this.lines.slice(-8).join('\n')}`)), ms)
      this.waiters.push({ name, res: () => (clearTimeout(t), res()) })
      this.exited.then((e) => (clearTimeout(t), rej(new Error(`child exited ${JSON.stringify(e)} before ${name}\n${this.lines.slice(-8).join('\n')}`))))
    })
  }
  async sigkill(): Promise<NodeJS.Signals | null> {
    this.proc.kill('SIGKILL')
    return (await this.exited).signal
  }
  release() { this.proc.stdin!.write('go\n') }
  async finish(): Promise<{ code: number | null; done?: Done }> {
    const { code } = await this.exited
    const l = this.lines.find((x) => x.startsWith('@@DONE '))
    return { code, ...(l ? { done: JSON.parse(l.slice(7)) as Done } : {}) }
  }
  charges() { return this.lines.filter((l) => l.startsWith('@@CHARGE')) }
}

// ---------------------------------------------------------------- cases
interface Check { name: string; pass: boolean; detail?: string }
interface CaseResult { id: string; title: string; mode: string; checks: Check[]; notes: string[]; ledger: string; journal: string; pass: boolean }
const throttleFile = join(work, 'throttle.json')
let seq = 0

class Ctx {
  checks: Check[] = []
  notes: string[] = []
  agent: string
  run: string
  ledger: string
  constructor(public id: string, public mode: string) {
    this.agent = `kt-${mode}`
    this.run = `c${id}-${mode}-${stamp}-${seq++}`
    this.ledger = join(work, `${this.run}.ledger`)
  }
  check(name: string, pass: boolean, detail = '') { this.checks.push({ name, pass, detail }) }
  note(s: string) { this.notes.push(s) }
  lines(): string[] { return existsSync(this.ledger) ? readFileSync(this.ledger, 'utf8').split('\n').filter(Boolean) : [] }
  child(over: Partial<Cfg> = {}): Child {
    return new Child({ agent: this.agent, runId: this.run, ledger: this.ledger, mode: this.mode as 'scripted' | 'live', stream: false, dedupes: false, throttleFile, liveBudget: 60, ...over })
  }
  async killAt(point: NonNullable<Cfg['pauseAt']>, over: Partial<Cfg> = {}): Promise<Child> {
    const c = this.child({ pauseAt: point, ...over })
    await c.waitAt(point)
    const sig = await c.sigkill()
    this.check(`killed at ${point} with SIGKILL`, sig === 'SIGKILL', String(sig))
    return c
  }
  async journal() { return journal(this.agent, this.run) }
}

type CaseFn = (x: Ctx) => Promise<void>
const live = (m: string) => m === 'live'
const fmtErr = (d?: Done) => (d?.error ? `${d.error.name}: ${d.error.message.slice(0, 120)}` : 'no error')

/** Key of the charge's tool_started, whatever step the model put it in. */
const chargeKey = (evs: Ev[]) => evs.find((e) => e.kind === 'loop.tool_started' && e.payload.tool === 'charge')?.payload.key as string | undefined

const case1: CaseFn = async (x) => {
  const a = await x.killAt('charge_entry')
  let j = await x.journal()
  const key = chargeKey(j)
  x.check('journal has tool_started(charge) and no tool_finished for it', !!key && !has(j, 'tool_finished', (p) => p.key === key), summary(j))
  x.check('ledger empty at the kill (side effect had not run)', x.lines().length === 0, `${x.lines().length} lines; child stdout: ${a.charges().join(',') || 'no charge'}`)

  const b = x.child()
  const rb = await b.finish()
  j = await x.journal()
  x.check('restart (default stop) reports unknown outcome', rb.code === 3 && rb.done?.error?.name === 'ArgenticUnknownOutcome', fmtErr(rb.done))
  x.check('journal has tool_unknown for the key', has(j, 'tool_unknown', (p) => p.key === key))
  x.check('charge did not run on the stop restart', rb.done?.stats.toolRuns.charge === 0 && x.lines().length === 0, `toolRuns.charge=${rb.done?.stats.toolRuns.charge} ledger=${x.lines().length}`)
  x.check('stop restart made no model call (m0, m1 served from the journal)', rb.done?.stats.providerAttempts === 0, `providerAttempts=${rb.done?.stats.providerAttempts}`)

  const c = x.child({ dedupes: true })
  const rc = await c.finish()
  j = await x.journal()
  const full = key ? `${x.agent}:${x.run}:${key}` : ''
  x.check('restart with dedupesOnKey finishes', rc.code === 0 && rc.done?.ok === true, fmtErr(rc.done))
  x.check('charge reran exactly once, under the same key', x.lines().length === 1 && x.lines()[0]!.split('\t')[0] === full && rc.done?.stats.toolRuns.charge === 1, `ledger=${x.lines().join('|')} expected key ${full}`)
  x.check('journal has run_finished', has(j, 'run_finished'), summary(j))
}

const case2: CaseFn = async (x) => {
  await x.killAt('charge_done')
  let j = await x.journal()
  const key = chargeKey(j)
  const full = key ? `${x.agent}:${x.run}:${key}` : ''
  x.check('journal has tool_started(charge), no tool_finished', !!key && !has(j, 'tool_finished', (p) => p.key === key), summary(j))
  x.check('ledger has exactly one line at the kill', x.lines().length === 1, x.lines().join('|'))

  const b = x.child()
  const rb = await b.finish()
  x.check('restart (default stop) reports unknown outcome', rb.code === 3 && rb.done?.error?.name === 'ArgenticUnknownOutcome', fmtErr(rb.done))
  x.check('ledger still exactly one line', x.lines().length === 1, x.lines().join('|'))

  const c = x.child({ dedupes: true })
  const rc = await c.finish()
  j = await x.journal()
  x.check('restart with dedupesOnKey finishes', rc.code === 0 && rc.done?.ok === true, fmtErr(rc.done))
  x.check('the tool saw the same key and a key-deduping charge refused', rc.done?.stats.charges.length === 1 && rc.done.stats.charges[0] === `refused ${full}`, JSON.stringify(rc.done?.stats.charges))
  x.check('ledger still exactly one line', x.lines().length === 1, x.lines().join('|'))
  x.check('journal has run_finished', has(j, 'run_finished'), summary(j))
}

const case3: CaseFn = async (x) => {
  await x.killAt('before_model_after_charge')
  let j = await x.journal()
  const key = chargeKey(j)
  x.check('journal has tool_finished(charge) before the kill', !!key && has(j, 'tool_finished', (p) => p.key === key && p.outcome === 'ok'), summary(j))
  x.check('ledger has exactly one line', x.lines().length === 1, x.lines().join('|'))
  const b = x.child()
  const rb = await b.finish()
  j = await x.journal()
  x.check('restart finishes (default stop, no dedupesOnKey)', rb.code === 0 && rb.done?.ok === true, fmtErr(rb.done))
  x.check('charge not rerun: no tool execution, ledger still one line', rb.done?.stats.toolRuns.charge === 0 && x.lines().length === 1, `toolRuns=${JSON.stringify(rb.done?.stats.toolRuns)} ledger=${x.lines().length}`)
  x.check('only the unrecorded answer step went to the model', rb.done?.stats.providerAttempts === 1, `providerAttempts=${rb.done?.stats.providerAttempts}`)
  x.check('journal has run_finished', has(j, 'run_finished'), summary(j))
}

const case4: CaseFn = async (x) => {
  const a = await x.killAt('stream_charge_part', { stream: true })
  let j = await x.journal()
  x.check('no tool_started for charge in the journal', chargeKey(j) === undefined, summary(j))
  x.check('the streamed step was not recorded (no model_step for the charge call)', !has(j, 'model_step', (p) => JSON.stringify(p.response?.content ?? []).includes('"toolName":"charge"')), summary(j))
  x.check('charge had not run (no @@CHARGE from the killed child, ledger empty)', a.charges().length === 0 && x.lines().length === 0)
  const b = x.child({ stream: true })
  const rb = await b.finish()
  j = await x.journal()
  x.check('restart finishes', rb.code === 0 && rb.done?.ok === true, fmtErr(rb.done))
  x.check('restart called the model live', (rb.done?.stats.providerAttempts ?? 0) >= 1, `providerAttempts=${rb.done?.stats.providerAttempts}`)
  x.check('charge ran at most once overall (ledger exactly one line, one distinct key)', x.lines().length === 1 && rb.done?.stats.toolRuns.charge === 1, `ledger=${x.lines().join('|')} toolRuns.charge=${rb.done?.stats.toolRuns.charge}`)
  x.check('journal has run_finished', has(j, 'run_finished'), summary(j))
}

const case5: CaseFn = async (x) => {
  const a = x.child({ pauseAt: 'charge_call_received' })
  await a.waitAt('charge_call_received')
  const b = x.child()
  const rb = await b.finish()
  let j = await x.journal()
  x.check('B completes', rb.code === 0 && rb.done?.ok === true, fmtErr(rb.done))
  x.check('ledger has one charge after B', x.lines().length === 1, x.lines().join('|'))
  x.check('two run_started events (A epoch, then B epoch)', count(j, 'run_started') === 2, summary(j))
  const before = j.length
  a.release()
  const ra = await a.finish()
  j = await x.journal()
  x.check("A's next write is fenced (409) and A stops", ra.code === 3 && ra.done?.error?.name === 'ArgenticFenced' && ra.done.error.status === 409, fmtErr(ra.done))
  x.check('A ran nothing more after the fence: no charge executed, no @@CHARGE (its one lookup ran before the pause)', ra.done?.stats.toolRuns.charge === 0 && ra.done.stats.toolRuns.lookup === 1 && a.charges().length === 0, JSON.stringify(ra.done?.stats.toolRuns))
  x.check("A's fenced write added nothing to the journal", j.length === before, `${before} -> ${j.length} events`)
  x.check('ledger has one charge at the end', x.lines().length === 1, x.lines().join('|'))
  x.check('journal has run_finished once', count(j, 'run_finished') === 1, summary(j))
}

/** Informational: the fence only bites at a write. A paused after tool_started, B takes over, A resumes into its side effect. */
const case5b: CaseFn = async (x) => {
  const a = x.child({ pauseAt: 'charge_entry', dedupes: true })
  await a.waitAt('charge_entry')
  const b = x.child({ dedupes: true })
  const rb = await b.finish()
  x.check('B completes (reruns the started charge under its key)', rb.code === 0 && rb.done?.ok === true, fmtErr(rb.done))
  a.release()
  const ra = await a.finish()
  const j = await x.journal()
  x.check("A's tool_finished write is fenced", ra.code === 3 && ra.done?.error?.name === 'ArgenticFenced', fmtErr(ra.done))
  x.check('ledger has one line (a key-deduping charge refused the second attempt)', x.lines().length === 1, `${x.lines().join('|')} ; A stdout: ${a.charges().join(',')}`)
  x.note(`A's charge call after release: ${a.charges().join(', ') || 'none'}. Fencing stops A at its next write, not inside a running tool: only a tool that dedupes on the key is safe here.`)
  x.check('journal has run_finished once', count(j, 'run_finished') === 1, summary(j))
}

function retryCase(status: number, via: 'throw' | 'fetch'): CaseFn {
  return async (x) => {
    const fail = { afterTools: 1, status, via }
    const a = x.child({ pauseAt: 'charge_entry', dedupes: true, fail })
    await a.waitAt('charge_entry')
    await a.sigkill()
    x.check(`the provider failure was injected once and the SDK retried the step`, a.lines.filter((l) => l.startsWith('@@FAIL')).length === 1, a.lines.filter((l) => l.startsWith('@@FAIL')).join(','))
    let j = await x.journal()
    const steps0 = stepsOf(j)
    x.check('after the retry, steps m0 and m1 are each recorded once', steps0.length === 2 && steps0[0]!.startsWith('m0:') && steps0[1]!.startsWith('m1:'), summary(j))
    const b = x.child({ dedupes: true, fail })
    const rb = await b.finish()
    j = await x.journal()
    x.check('restart finishes with no divergence', rb.code === 0 && rb.done?.ok === true, fmtErr(rb.done))
    const steps1 = stepsOf(j)
    x.check('step numbering unchanged: m0, m1, m2, one record each, earlier hashes identical', steps1.length === 3 && steps1.slice(0, 2).join() === steps0.join() && steps1[2]!.startsWith('m2:'), steps1.join(' '))
    x.check('ledger exactly one line', x.lines().length === 1, x.lines().join('|'))
    const before = work_events(j)
    const c = x.child({ dedupes: true, fail })
    const rc = await c.finish()
    j = await x.journal()
    x.check('a third start replays everything: ok, no model call, no tool run, nothing appended but its own run_started', rc.code === 0 && rc.done?.stats.providerAttempts === 0 && rc.done.stats.toolRuns.charge === 0 && rc.done.stats.toolRuns.lookup === 0 && work_events(j) === before, `${fmtErr(rc.done)} attempts=${rc.done?.stats.providerAttempts} non-open events ${before}->${work_events(j)}`)
    x.note(`first process saw the injected ${status} once (${via}); the SDK retried the whole step (maxRetries 2)`)
  }
}

const case8: CaseFn = async (x) => {
  const a = x.child({ lookupDate: true })
  const ra = await a.finish()
  let j = await x.journal()
  x.check('first run finishes', ra.code === 0 && ra.done?.ok === true, fmtErr(ra.done))
  const fin = j.find((e) => e.kind === 'loop.tool_finished' && e.payload.key === 'm0.t0')
  x.check('the Date is recorded as an ISO string', fin?.payload.result?.since === '2024-01-02T03:04:05.000Z', JSON.stringify(fin?.payload.result))
  const before = work_events(j)
  const b = x.child({ lookupDate: true })
  const rb = await b.finish()
  j = await x.journal()
  x.check('restart replays with no divergence, no model call, no tool run, nothing appended but its own run_started', rb.code === 0 && rb.done?.stats.providerAttempts === 0 && rb.done.stats.toolRuns.lookup === 0 && work_events(j) === before, `${fmtErr(rb.done)} attempts=${rb.done?.stats.providerAttempts} non-open events ${before}->${work_events(j)}`)
  x.check('ledger exactly one line', x.lines().length === 1, x.lines().join('|'))
  // and a kill in the middle: lookup finished, the next step not recorded
  const y = new Ctx('8k', x.mode)
  const k = await y.killAt('before_model_after_lookup', { lookupDate: true })
  void k
  const r = await y.child({ lookupDate: true }).finish()
  const jj = await y.journal()
  x.check('kill after the Date-returning tool, restart finishes', r.code === 0 && r.done?.ok === true && has(jj, 'run_finished'), fmtErr(r.done))
  x.check('ledger exactly one line in the kill variant', y.lines().length === 1, y.lines().join('|'))
}

const CASES: Record<string, { title: string; fn: CaseFn; live: boolean }> = {
  '1': { title: 'killed after tool_started(charge), before the side effect', fn: case1, live: true },
  '2': { title: 'killed after the side effect, before tool_finished', fn: case2, live: false },
  '3': { title: 'killed after tool_finished', fn: case3, live: true },
  '4': { title: 'streamText killed after a tool-call part arrived, before the step was recorded', fn: case4, live: true },
  '5': { title: 'two live processes on one run id (the second fences the first)', fn: case5, live: true },
  '5b': { title: '(extra) fence vs a tool already running: A paused inside charge, B takes over', fn: case5b, live: false },
  '6': { title: 'provider 429 once, retried by the SDK (thrown by a wrapper)', fn: retryCase(429, 'throw'), live: false },
  '6b': { title: 'provider 429 once, retried by the SDK (real provider package, injected fetch)', fn: retryCase(429, 'fetch'), live: false },
  '7': { title: 'a whole step retried by maxRetries (provider 500 once)', fn: retryCase(500, 'throw'), live: false },
  '8': { title: 'a tool returning a non-JSON value (Date)', fn: case8, live: false },
}

// ---------------------------------------------------------------- latency (case 9)
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : NaN)
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN)
const f = (n: number) => n.toFixed(1)

async function latency(): Promise<{ md: string; pass: boolean }> {
  const runOnce = async (agent: string, tag: string) => {
    const run = `lat-${tag}-${stamp}-${seq++}`
    const cfg: Cfg = { agent, runId: run, ledger: join(work, `${run}.ledger`), mode: 'scripted', stream: false, dedupes: false }
    const r = await new Child(cfg).finish()
    if (!r.done?.ok) throw new Error(`latency run failed: ${fmtErr(r.done)}`)
    return r.done.stats.writes
  }
  const first = await runOnce(`kt-lat-new-${stamp}`, 'scope') // an agent name this account has not used yet
  const warmRuns: { kind: string; ms: number }[][] = []
  for (let i = 0; i < 20; i++) warmRuns.push(await runOnce(`kt-lat-${stamp}`, `w${i}`))
  const warm = warmRuns.flat()
  const kinds = [...new Set(warm.map((w) => w.kind))]
  const perStep = warmRuns.map((r) => r.reduce((s, w) => s + w.ms, 0) / 3) // 3 model steps per run
  const perStepSum = warmRuns.map((r) => r.filter((w) => w.kind !== 'open').reduce((s, w) => s + w.ms, 0) / 3)
  const rows = kinds.map((k) => { const v = warm.filter((w) => w.kind === k).map((w) => w.ms); return `| ${k} | ${v.length} | ${f(median(v))} | ${f(pct(v, 0.95))} | ${f(Math.max(...v))} |` })
  const firstEvents = first.filter((w) => w.kind !== 'open')[0]!
  const md = [
    '| write | n | median ms | p95 ms | max ms |',
    '|---|---|---|---|---|',
    `| all writes | ${warm.length} | ${f(median(warm.map((w) => w.ms)))} | ${f(pct(warm.map((w) => w.ms), 0.95))} | ${f(Math.max(...warm.map((w) => w.ms)))} |`,
    ...rows,
    '',
    `- Added by writes per model step (3 model steps and ${warmRuns[0]!.length} writes incl. open per run; ${warmRuns.length} runs): median ${f(median(perStep))} ms (open included), ${f(median(perStepSum))} ms (open excluded).`,
    `- First writes on an agent name this account had not used: open ${f(first[0]!.ms)} ms; first events write (${firstEvents.kind}) ${f(firstEvents.ms)} ms.`,
    '- Round trips as the client sees them, from the machine that ran this test. They depend on the network between that machine and the API.',
  ].join('\n')
  return { md, pass: warm.every((w) => !w.kind.includes(':')) && Number.isFinite(median(perStep)) }
}

// ---------------------------------------------------------------- main
async function main(): Promise<number> {
  if (MODES.includes('live') && !secret) { console.error('live mode needs NV_API_KEY'); return 2 }
  if (MODES.includes('live') && !existsSync(join(here, 'node_modules/@ai-sdk/openai-compatible'))) { console.error(`live mode and case 6b need: cd ${here} && npm install`); return 2 }
  if (!BASE || !apiKey) { console.error('set ARGENTIC_BASE_URL and ARGENTIC_API_KEY (see the header of this file)'); return 2 }
  const why = await preflight()
  if (why) { console.error(`cannot run: ${why}`); return 2 }
  mkdirSync(work, { recursive: true })
  const results: CaseResult[] = []
  const wanted = (id: string, mode: string) => (!ONLY || ONLY.has(id)) && (mode === 'scripted' || CASES[id]!.live)
  for (const mode of MODES) {
    for (const id of Object.keys(CASES)) {
      if (!wanted(id, mode)) continue
      if (id === '6b' && !existsSync(join(here, 'node_modules/@ai-sdk/openai-compatible'))) { console.error('skip 6b: npm install first'); continue }
      const x = new Ctx(id, mode)
      const t0 = Date.now()
      try { await CASES[id]!.fn(x) } catch (e: any) { x.check('case ran to its end', false, scrub(String(e?.stack ?? e)).slice(0, 600)) }
      const j = await x.journal().catch(() => [] as Ev[])
      const r: CaseResult = { id, title: CASES[id]!.title, mode, checks: x.checks, notes: x.notes, ledger: `${x.lines().length} line(s)${x.lines().length ? ': ' + x.lines().map((l) => l.split('\t')[0]!.split(':').pop()).join(', ') : ''}`, journal: summary(j), pass: x.checks.every((c) => c.pass) }
      results.push(r)
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  case ${id} [${mode}] ${r.title}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      for (const c of r.checks) console.log(`   ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass ? '' : '  <- ' + c.detail}`)
    }
  }
  let lat: { md: string; pass: boolean } | undefined
  if (!ONLY || ONLY.has('9')) { lat = await latency(); console.log('case 9 latency\n' + lat.md) }
  const live = existsSync(throttleFile) ? (JSON.parse(readFileSync(throttleFile, 'utf8')) as { count: number }).count : 0
  const md = render(results, lat, live)
  if (OUT) writeFileSync(OUT, md)
  const allPass = results.every((r) => r.pass) && (lat?.pass ?? true)
  console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES'}: ${results.filter((r) => r.pass).length}/${results.length} case runs passed; live provider calls: ${live}; work dir ${work}`)
  return allPass ? 0 : 1
}

function render(rs: CaseResult[], lat: { md: string; pass: boolean } | undefined, liveCalls: number): string {
  const out: string[] = ['| case | mode | result | ledger | journal |', '|---|---|---|---|---|']
  for (const r of rs) out.push(`| ${r.id} ${r.title} | ${r.mode} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.ledger} | ${r.journal.replaceAll('|', '\\|')} |`)
  out.push('')
  for (const r of rs) {
    out.push(`### Case ${r.id} (${r.mode}): ${r.title} - ${r.pass ? 'PASS' : 'FAIL'}`, '')
    for (const c of r.checks) out.push(`- ${c.pass ? 'ok' : 'FAIL'}: ${c.name}${c.detail ? ` (${c.detail.replaceAll('\n', ' ')})` : ''}`)
    for (const n of r.notes) out.push(`- note: ${n}`)
    out.push('')
  }
  if (lat) out.push('### Case 9: latency', '', lat.md, '')
  out.push(`Live provider calls made: ${liveCalls}`)
  return out.join('\n')
}

process.exitCode = await main().catch((e) => { console.error(scrub(String(e?.stack ?? e))); return 2 })
process.exit(process.exitCode as number)
