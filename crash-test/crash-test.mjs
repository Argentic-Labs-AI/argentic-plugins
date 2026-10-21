#!/usr/bin/env node
// crash-test: kill any agent at each of its tool calls, restart it, and report which side effects landed twice.
// Framework-agnostic and zero-dependency. It watches outside behaviour only: a local HTTP sink that the agent's tools
// call instead of the real services, and a ledger of what arrived. It knows nothing about how the agent is built.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const usage = `crash-test: kill an agent at each tool call, restart it, and see which side effects repeated.

Usage:
  crash-test [options] -- <command that runs your agent>

  crash-test -- node my-agent.js
  crash-test --when mid --kill-at 1,3 -- python agent.py

Point your agent's tool endpoints (refund, email, ticket, ...) at $CRASHTEST_SINK_URL. The sink answers every
request with 200 {"ok":true} and records it. Your agent also gets $CRASHTEST_STATE_DIR, a folder that survives
the kill, for agents that keep their own checkpoints.

Options:
  --kill-at <list|all>   which tool calls to kill at, 1-based, e.g. 1,3 (default: all)
  --when <list>          mid  = kill after the sink applied the call but before it answers (the agent never sees the reply)
                         done = kill right after the sink has answered (default: mid,done)
  --identity <route|body>  what counts as "the same action": METHOD+path (default), or METHOD+path+body
  --no-dedupe            do not treat a repeat of an Idempotency-Key as absorbed; count it as a second effect
  --cwd <dir>            working directory for the agent (default: current directory)
  --copy-cwd             run every trial in a fresh copy of --cwd (skips node_modules and .git); use it if your agent keeps state in its cwd
  --timeout <seconds>    limit for each agent process (default: 120)
  --jobs <n>             trials in parallel (default: 1)
  --json <file>          write the full report as JSON
  --md <file>            write the report as Markdown
  --keep                 keep the per-trial folders and agent logs
  --verbose              show the agent's output
  --no-promo             leave the closing line off the report
  -h, --help

Exit status: 0 nothing duplicated or lost, 1 a side effect landed twice or never, 2 a trial could not finish or the setup is wrong.`

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'kill-at': { type: 'string', default: 'all' },
    when: { type: 'string', default: 'mid,done' },
    identity: { type: 'string', default: 'route' },
    'no-dedupe': { type: 'boolean', default: false },
    cwd: { type: 'string' },
    'copy-cwd': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '120' },
    jobs: { type: 'string', default: '1' },
    json: { type: 'string' },
    md: { type: 'string' },
    keep: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    'no-promo': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const fail = (msg) => {
  console.error(`crash-test: ${msg}\n\n${usage}`)
  process.exit(2)
}
if (opt.help) {
  console.log(usage)
  process.exit(0)
}
const command = positionals.join(' ').trim()
if (!command) fail('no agent command given. Put it after "--".')
const whens = opt.when.split(',').map((s) => s.trim()).filter(Boolean)
if (!whens.length || whens.some((w) => w !== 'mid' && w !== 'done')) fail('--when takes mid, done, or both')
if (opt.identity !== 'route' && opt.identity !== 'body') fail('--identity takes route or body')
const timeoutMs = Number(opt.timeout) * 1000
const jobs = Math.max(1, Number(opt.jobs) || 1)
if (!(timeoutMs > 0)) fail('--timeout must be a number of seconds')
const agentCwd = resolve(opt.cwd ?? process.cwd())
const dedupe = !opt['no-dedupe']

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const out = (s = '') => process.stdout.write(s + '\n')

/** A local stand-in for the services the agent's tools call. It records every request and can kill the agent at one of them. */
function startSink({ killAt, when, kill }) {
  const arrivals = []
  const state = { attempt: 1, killed: false }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const a = {
        n: arrivals.length + 1,
        attempt: state.attempt,
        method: req.method,
        path: new URL(req.url, 'http://sink').pathname,
        key: req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'] ?? null,
        bodyHash: createHash('sha256').update(body).digest('hex').slice(0, 10),
        acked: false,
      }
      arrivals.push(a)
      const hit = killAt != null && !state.killed && state.attempt === 1 && a.n === killAt
      if (hit && when === 'mid') {
        state.killed = true
        kill()
        req.socket.destroy()
        return
      }
      const reply = JSON.stringify({ ok: true, id: `sink-${a.n}` })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reply) })
      res.end(reply, () => {
        a.acked = true
        if (hit) {
          state.killed = true
          kill()
        }
      })
    })
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () =>
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        arrivals,
        state,
        close: () => server.close(),
        setKill: (fn) => (kill = fn),
      }),
    ),
  )
}

/** Run the agent command in its own process group so a kill takes its children too. */
function runAgent({ cwd, env, logPath }) {
  const fd = opt.verbose ? 'inherit' : openSync(logPath, 'a')
  const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: opt.verbose ? 'inherit' : ['ignore', fd, fd] })
  const killGroup = () => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  const done = new Promise((ok) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (fd !== 'inherit') closeSync(fd)
      ok({ code, signal, timedOut })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      ok({ code: 127, signal: null, timedOut: false, error: String(e) })
    })
  })
  return { killGroup, done }
}

const group = (a) => (opt.identity === 'body' ? `${a.method} ${a.path} #${a.bodyHash}` : `${a.method} ${a.path}`)

/** What really landed: arrivals per action, with a repeat of the same Idempotency-Key counted as one effect when the receiver dedupes. */
function tally(arrivals) {
  const groups = new Map()
  const seen = new Set()
  for (const a of arrivals) {
    const g = group(a)
    const t = groups.get(g) ?? { applied: 0, replays: 0, arrivals: 0, firstAcked: null }
    t.arrivals++
    if (t.firstAcked === null) t.firstAcked = a.acked
    const id = a.key ? `${g}\0${a.key}` : null
    if (dedupe && id && seen.has(id)) t.replays++
    else t.applied++
    if (id) seen.add(id)
    groups.set(g, t)
  }
  return groups
}

function trialEnv(sink, stateDir, trial) {
  return { ...process.env, CRASHTEST_SINK_URL: sink.url, CRASHTEST_STATE_DIR: stateDir, CRASHTEST_TRIAL: String(trial) }
}

function prepareDir(label) {
  const root = mkdtempSync(join(tmpdir(), `crash-test-${label}-`))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir)
  let cwd = agentCwd
  if (opt['copy-cwd']) {
    cwd = join(root, 'cwd')
    cpSync(agentCwd, cwd, {
      recursive: true,
      filter: (src) => !/(^|\/)(node_modules|\.git)$/.test(src),
    })
    if (existsSync(join(agentCwd, 'node_modules'))) symlinkSync(join(agentCwd, 'node_modules'), join(cwd, 'node_modules'))
  }
  return { root, stateDir, cwd, logPath: join(root, 'agent.log') }
}

async function baseline() {
  const dir = prepareDir('baseline')
  const sink = await startSink({ killAt: null, when: 'mid', kill: () => {} })
  const run = runAgent({ cwd: dir.cwd, env: trialEnv(sink, dir.stateDir, 0), logPath: dir.logPath })
  const res = await run.done
  sink.close()
  if (!opt.keep) rmSync(dir.root, { recursive: true, force: true })
  return { res, arrivals: sink.arrivals, logPath: dir.logPath, root: dir.root }
}

async function trial(k, when, expected, n) {
  const dir = prepareDir(`k${k}-${when}`)
  const sink = await startSink({ killAt: k, when, kill: () => {} })
  const env = trialEnv(sink, dir.stateDir, n)
  const first = runAgent({ cwd: dir.cwd, env, logPath: dir.logPath })
  sink.setKill(first.killGroup)
  const r1 = await first.done
  const r = { k, when, verdict: 'ok', issues: [], arrivals: sink.arrivals, firstRun: r1 }
  if (!sink.state.killed) {
    sink.close()
    r.verdict = 'not-reached'
    r.note = `the agent finished (exit ${r1.code}) before making call #${k}`
    if (!opt.keep) rmSync(dir.root, { recursive: true, force: true })
    return r
  }
  sink.state.attempt = 2
  const second = runAgent({ cwd: dir.cwd, env, logPath: dir.logPath })
  const r2 = await second.done
  sink.close()
  r.secondRun = r2
  const got = tally(sink.arrivals)
  for (const g of new Set([...expected.keys(), ...got.keys()])) {
    const want = expected.get(g)?.applied ?? 0
    const t = got.get(g) ?? { applied: 0, replays: 0, arrivals: 0, firstAcked: null }
    if (t.applied > want) r.issues.push({ kind: 'duplicated', action: g, expected: want, applied: t.applied, replays: t.replays, firstAcked: t.firstAcked })
    else if (t.applied < want) r.issues.push({ kind: 'lost', action: g, expected: want, applied: t.applied })
    else if (t.replays) r.issues.push({ kind: 'replayed', action: g, expected: want, applied: t.applied, replays: t.replays, firstAcked: t.firstAcked })
  }
  const bad = r.issues.filter((i) => i.kind !== 'replayed')
  if (r2.timedOut || r2.code !== 0) {
    r.verdict = 'incomplete'
    r.note = r2.timedOut ? 'the restarted agent hit the timeout' : `the restarted agent exited with code ${r2.code}`
  } else if (bad.length) {
    r.verdict = bad.some((i) => i.kind === 'duplicated') ? 'duplicated' : 'lost'
    if (bad.some((i) => i.kind === 'duplicated') && bad.some((i) => i.kind === 'lost')) r.verdict = 'duplicated+lost'
  }
  r.logPath = dir.logPath
  if (!opt.keep && r.verdict !== 'incomplete') rmSync(dir.root, { recursive: true, force: true })
  else r.keptAt = dir.root
  return r
}

async function pool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    }),
  )
  return results
}

const label = (a) => `${a.method} ${a.path}`

async function main() {
  out(bold('crash-test'))
  out(dim(`agent: ${command}`))
  out(dim(`identity: ${opt.identity}, dedupe on Idempotency-Key: ${dedupe ? 'yes' : 'no'}`))
  out()

  const base = await baseline()
  if (base.res.timedOut || base.res.code !== 0) {
    console.error(red(`The agent did not finish a clean run (${base.res.timedOut ? 'timeout' : `exit ${base.res.code}`}). Fix that first.`))
    if (base.arrivals.length === 0) console.error('It made no calls to $CRASHTEST_SINK_URL either. Point its tool endpoints there.')
    if (!opt.verbose) console.error(dim(`Run with --verbose to see its output.`))
    process.exit(2)
  }
  const calls = base.arrivals
  if (!calls.length) {
    console.error(red('The agent finished but made no calls to $CRASHTEST_SINK_URL, so there is nothing to kill it at.'))
    console.error('Point its tool endpoints (refund, email, ticket, ...) at that address.')
    process.exit(2)
  }
  const expected = tally(calls)
  out(`Clean run: ${calls.length} call${calls.length === 1 ? '' : 's'} to the sink`)
  calls.forEach((a) => out(`  #${a.n} ${label(a)}${a.key ? dim(`  key ${a.key}`) : dim('  no key')}`))
  out()

  const only = opt['kill-at'] === 'all' ? null : new Set(opt['kill-at'].split(',').map(Number))
  if (only && [...only].some((k) => !Number.isInteger(k) || k < 1 || k > calls.length)) fail(`--kill-at must be between 1 and ${calls.length}`)
  const plan = []
  for (let k = 1; k <= calls.length; k++) if (!only || only.has(k)) for (const w of whens) plan.push({ k, when: w })
  out(`Killing at ${plan.length} point${plan.length === 1 ? '' : 's'}, restarting each time...`)
  out()

  const results = await pool(plan, jobs, async (p, i) => {
    const r = await trial(p.k, p.when, expected, i + 1)
    r.call = calls[p.k - 1] ?? { method: '?', path: '?' }
    return r
  })

  const sym = { ok: green('✓'), 'not-reached': dim('–'), incomplete: yellow('!'), duplicated: red('✗'), lost: red('✗'), 'duplicated+lost': red('✗') }
  for (const r of results) {
    const head = `${sym[r.verdict]} kill ${r.when.padEnd(4)} at #${r.k} ${label(r.call).padEnd(28)}`
    const detail = [
      ...r.issues.filter((i) => i.kind === 'duplicated').map((i) => `${i.action} landed ${i.applied}× (expected ${i.expected})${i.firstAcked ? ', after the first one was acknowledged' : ', after the first one was cut off'}`),
      ...r.issues.filter((i) => i.kind === 'lost').map((i) => `${i.action} never landed`),
      ...r.issues.filter((i) => i.kind === 'replayed').map((i) => `${i.action} came again with the same key (${i.replays}×), absorbed`),
      ...(r.note ? [r.note] : []),
    ]
    out(`${head} ${detail.length ? detail.join('; ') : dim('every action landed once')}`)
  }

  const count = (v) => results.filter((r) => r.verdict === v).length
  const dup = results.filter((r) => r.verdict.startsWith('duplicated')).length
  const lost = results.filter((r) => r.verdict.endsWith('lost')).length
  const incomplete = count('incomplete')
  const replayed = results.filter((r) => r.issues.some((i) => i.kind === 'replayed')).length
  const exercised = results.filter((r) => r.verdict !== 'not-reached').length
  out()
  out(bold('Result'))
  out(`  kill points exercised:         ${exercised} of ${plan.length}`)
  out(`  trials with a duplicated effect: ${dup === 0 ? green(dup) : red(dup)}`)
  out(`  trials with a lost effect:       ${lost === 0 ? green(lost) : red(lost)}`)
  if (replayed) out(`  trials with an absorbed replay:  ${replayed} ${dim('(same Idempotency-Key; safe if the receiver dedupes on it)')}`)
  if (incomplete) out(`  trials that did not finish:      ${yellow(incomplete)}`)
  const failing = dup + lost > 0
  if (failing && !opt['no-promo']) {
    out()
    out(dim('A tool call is only safe to repeat if the thing receiving it can tell it has seen it before. Argentic (https://getargentic.com) is built to hand every action a stable key and skip the ones that finished. This test works on any agent, with or without it.'))
  }

  const report = {
    tool: 'crash-test',
    command,
    identity: opt.identity,
    dedupe,
    cleanRun: calls.map((a) => ({ n: a.n, action: label(a), key: a.key })),
    summary: { planned: plan.length, exercised, duplicated: dup, lost, replayed, incomplete },
    trials: results.map((r) => ({
      killAt: r.k,
      when: r.when,
      call: label(r.call),
      verdict: r.verdict,
      issues: r.issues,
      note: r.note ?? null,
      arrivals: r.arrivals.map((a) => ({ n: a.n, attempt: a.attempt, action: label(a), key: a.key, acked: a.acked })),
      keptAt: r.keptAt ?? null,
    })),
  }
  if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2) + '\n')
  if (opt.md) writeFileSync(opt.md, markdown(report))
  process.exit(failing ? 1 : incomplete ? 2 : 0)
}

function markdown(r) {
  const rows = r.trials.map((t) => {
    const what = t.issues
      .filter((i) => i.kind !== 'replayed')
      .map((i) => (i.kind === 'duplicated' ? `\`${i.action}\` landed ${i.applied}× (expected ${i.expected})` : `\`${i.action}\` never landed`))
      .join('; ')
    return `| ${t.killAt} | ${t.when} | \`${t.call}\` | ${t.verdict} | ${what || t.note || ''} |`
  })
  return [
    '# crash-test report',
    '',
    `Agent: \`${r.command}\``,
    '',
    `Kill points exercised: ${r.summary.exercised} of ${r.summary.planned}. Trials with a duplicated effect: ${r.summary.duplicated}. With a lost effect: ${r.summary.lost}. Did not finish: ${r.summary.incomplete}.`,
    '',
    '| Kill at call | When | Call | Verdict | What happened |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

await main()
