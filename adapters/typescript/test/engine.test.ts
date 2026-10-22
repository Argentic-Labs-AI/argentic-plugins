// The tool pack against a local hosted engine (from an agent-lab checkout) and mock providers. No real keys:
// the engine runs under `env -i` with a scripted model, and every provider is a local mock.
//
//   createdb argentic_pack_e2e
//   ARGENTIC_ENGINE_DIR=/path/to/agent-lab ENGINE_DATABASE_URL=postgres://ctx:ctx@localhost:5432/argentic_pack_e2e npm test
//
// Skipped when either variable is missing.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { githubMock, httpMock, resendMock, slackMock, stripeMock, type Mock } from './mocks.ts'

const engineDir = process.env.ARGENTIC_ENGINE_DIR
const dbUrl = process.env.ENGINE_DATABASE_URL
const skip = !engineDir || !dbUrl ? 'set ARGENTIC_ENGINE_DIR and ENGINE_DATABASE_URL to run against a local hosted engine' : false
const here = import.meta.dirname
const node = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']

let engine: ChildProcess
let base = ''
let apiKey = ''
let mocks: { stripe: Mock; resend: Mock; slack: Mock; github: Mock; http: Mock }
let dir = ''

before(async () => {
  if (skip) return
  dir = mkdtempSync(join(tmpdir(), 'argentic-e2e-'))
  mocks = { stripe: await stripeMock(), resend: await resendMock(), slack: await slackMock({ history: true }), github: await githubMock(), http: await httpMock({ honorsKey: true }) }
  // env -i: the engine starts with nothing but what it is given here.
  engine = spawn('env', ['-i', `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`, `ENGINE_DIR=${engineDir}`, `DATABASE_URL=${dbUrl}`, 'PORT=0', `HTTP_URL=${mocks.http.url}/hook`, process.execPath, ...node, join(here, 'engine/server.ts')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const line = await new Promise<string>((resolve, reject) => {
    let buf = ''
    engine.stdout!.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.split('\n')[0]) })
    engine.on('exit', (c) => reject(new Error(`engine exited ${c}`)))
  })
  const info = JSON.parse(line) as { listening: number; key: string }
  base = `http://127.0.0.1:${info.listening}`
  apiKey = info.key
})

after(async () => {
  engine?.kill()
  if (!skip) for (const m of Object.values(mocks)) await m.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const totals = () => ({ stripe: mocks.stripe.effects.length, resend: mocks.resend.effects.length, slack: mocks.slack.effects.length, github: mocks.github.effects.length, http: mocks.http.effects.length })
const reset = () => { for (const m of Object.values(mocks)) { m.effects.length = 0; m.requests.length = 0; (m as any).store?.clear?.() } }

// Async on purpose: the mock providers live in this process, so it must keep serving while a driver runs.
const drive = (agent: string, extra: Record<string, string> = {}) =>
  new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [...node, join(here, 'engine/driver.ts')], {
      env: {
        PATH: process.env.PATH!, BASE_URL: base, API_KEY: apiKey, AGENT: agent, RUN_ID: `run-${agent}`, STATE_DIR: join(dir, agent),
        STRIPE_URL: mocks.stripe.url, RESEND_URL: mocks.resend.url, SLACK_URL: mocks.slack.url, GITHUB_URL: mocks.github.url, HTTP_URL: `${mocks.http.url}/hook`, ...extra,
      },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code, signal) => resolve({ code, signal, out: out.trim() }))
  })

const once = { stripe: 1, resend: 1, slack: 1, github: 1, http: 1 }

test('a process killed hard mid-run, started again, repeats no finished action', { skip }, async () => {
  reset()
  const first = await drive('kill-a', { CRASH_AFTER: '2' })
  assert.equal(first.signal, 'SIGKILL', first.out)
  assert.deepEqual(totals(), { stripe: 1, resend: 1, slack: 0, github: 0, http: 0 })
  const second = await drive('kill-a')
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /"status":"done"/)
  assert.deepEqual(totals(), once)
  // Every side effect carried its own action's key (agent:seq), and the same one on the second run.
  const keys = [mocks.stripe, mocks.resend, mocks.http].map((m) => m.requests.map((r) => r.headers['idempotency-key'] as string))
  for (const k of keys.flat()) assert.match(k, /^kill-a:\d+$/)
  assert.equal(new Set(keys.flat()).size, 3)
})

test('every provider loses its first answer; the run stops, is started again, and each effect lands once', { skip }, async () => {
  reset()
  for (const m of Object.values(mocks)) m.dropNext = 1
  let stops = 0
  let last = await drive('drop-b')
  while (last.code === 3 && stops < 10) { stops++; last = await drive('drop-b') }
  assert.equal(last.code, 0, last.out)
  assert.match(last.out, /"status":"done"/)
  assert.equal(stops, 5, 'one stop per provider')
  assert.deepEqual(totals(), once)
})

test('a run finished and asked for again changes nothing', { skip }, async () => {
  reset()
  assert.equal((await drive('again-c')).code, 0)
  assert.equal((await drive('again-c')).code, 0)
  assert.deepEqual(totals(), once)
})
