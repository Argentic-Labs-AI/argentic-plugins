#!/usr/bin/env node
// crash-test: kill any agent at each of its tool calls, restart it, and report which side effects landed twice.
// Framework-agnostic and zero-dependency. It watches outside behaviour only: local sinks (HTTP, a Stripe-shaped payments API,
// SMTP) that the agent's tools call instead of the real services, and a ledger of what arrived. It knows nothing about how the agent is built.
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const usage = `crash-test: kill an agent at each tool call, restart it, and see which side effects repeated.

Usage:
  crash-test [options] -- <command that runs your agent>
  crash-test --demo

  crash-test --demo                  see it catch a bundled agent that double-sends (no setup)
  crash-test -- node my-agent.js
  crash-test --when mid,pause --kill-at 1,3 -- python agent.py

Point your agent's tools at the sinks the tool starts:
  $CRASHTEST_SINK_URL   HTTP. Answers 200 {"ok":true}. Paths under /v1/ behave like a payments API (see below).
  $CRASHTEST_SMTP_URL   SMTP (smtp://127.0.0.1:port; also $CRASHTEST_SMTP_HOST and $CRASHTEST_SMTP_PORT). Accepts any mail.
  $CRASHTEST_FILES_DIR  a folder for effect logs. Every complete line appended to a file in it counts as one effect.
                        Keep checkpoints out of it; they belong in the state folder.
  $CRASHTEST_DB_PATH    a SQLite file (Node 22.13+). Every row inserted into any table counts as one effect.
  $CRASHTEST_STATE_DIR  a folder that survives the kill, for agents that keep their own checkpoints.
  $CRASHTEST_UPSTREAM_<NAME>_URL  a pass-through to a service you name with --upstream (a model API, say). Its calls are
                        not effects; they are places to kill.

The /v1/ paths model a payments API: a new request makes an object (id, status "succeeded"); the same Idempotency-Key with
the same body returns the first answer; the same key with a different body is refused with 400 idempotency_error.

Options:
  --kill-at <list|all>   which calls to kill at, 1-based, e.g. 1,3 (default: all)
  --when <list>          mid   = the sink applied the call but the agent never gets the reply, then SIGKILL
                         done  = the sink answered, then SIGKILL
                         pause = freeze the agent (SIGSTOP) with call k held back, restart another copy, then let the
                                 frozen one go. This is a worker that was paused, not killed.
                         upstream     = kill right after an upstream reply reaches the agent, before it can act on it
                         upstream-mid = kill with the upstream reply withheld (the service did its work, the agent never heard)
                         (default: mid,done; with --upstream also upstream,upstream-mid)
                         For files and database rows the effect has already happened when the tool sees it, so mid acts as done.
  --upstream <n=url>     pass-through to a service, e.g. model=https://integrate.api.nvidia.com/v1 . Repeatable. Responses are buffered, so streaming does not pass.
  --upstream-rpm <n>     most upstream requests per minute across the whole run (default: no limit)
  --kill-upstream-at <list|all>  which upstream calls to kill at (default: all)
  --trial-gap <s>        wait this long between trials, to go easy on a shared rate limit (default: 0)
  --takeover-after <s>   with pause: seconds to wait before the restart starts (default: 0)
  --identity <route|body>  what counts as "the same action": METHOD+path (default), or METHOD+path+body
  --intent <fields>      also identify an action by these top-level body fields, e.g. order_id,to. Use it when the path alone
                         does not say which thing was done, or to follow an LLM agent that takes a different route.
  --samples <n>          clean runs to learn from (default: 1). An LLM agent that varies needs 3 or more.
  --no-dedupe            do not treat a repeat of an Idempotency-Key as absorbed; count it as a second effect
  --cwd <dir>            working directory for the agent (default: current directory)
  --copy-cwd             run every trial in a fresh copy of --cwd (skips node_modules and .git)
  --timeout <seconds>    limit for each agent process (default: 120)
  --jobs <n>             trials in parallel (default: 1)
  --json <file|->        write the full report as JSON. With "-" the JSON goes to stdout and the readable report to stderr.
  --md <file>            write the report as Markdown
  --keep                 keep the per-trial folders and agent logs
  --verbose              show the agent's output
  --demo                 run the bundled example agent (a plain loop with no safeguards) instead of your command
  --no-promo             leave the closing line off the report
  -v, --version
  -h, --help

Exit status: 0 nothing duplicated or lost, 1 a side effect landed twice or never, 2 a trial could not finish or the setup is wrong.
A trial where the agent took a different path than the clean run is reported as "path diverged" and is not a failure by itself.`

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'kill-at': { type: 'string', default: 'all' },
    when: { type: 'string', default: 'mid,done' },
    'takeover-after': { type: 'string', default: '0' },
    upstream: { type: 'string', multiple: true, default: [] },
    'upstream-rpm': { type: 'string', default: '0' },
    'kill-upstream-at': { type: 'string', default: 'all' },
    'trial-gap': { type: 'string', default: '0' },
    identity: { type: 'string', default: 'route' },
    intent: { type: 'string', default: '' },
    samples: { type: 'string', default: '1' },
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
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
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
const here = fileURLToPath(new URL('.', import.meta.url))
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()
if (opt.version) {
  console.log(version)
  process.exit(0)
}
if (opt.demo && positionals.length) fail('--demo runs the bundled agent; leave the command off, or drop --demo to test your own')
const command = opt.demo ? `node '${join(here, 'examples', 'plain-agent.mjs').replace(/'/g, `'\\''`)}'` : positionals.join(' ').trim()
if (!command) fail('no agent command given. Put it after "--", or try --demo.')
const upstreams = new Map()
for (const u of opt.upstream) {
  const m = /^([A-Za-z0-9_-]+)=(https?:\/\/.+)$/.exec(u)
  if (!m) fail(`--upstream takes name=url, got "${u}"`)
  upstreams.set(m[1], m[2].replace(/\/+$/, ''))
}
const whenDefault = upstreams.size ? 'mid,done,upstream,upstream-mid' : 'mid,done'
const whens = (opt.when === 'mid,done' ? whenDefault : opt.when).split(',').map((s) => s.trim()).filter(Boolean)
if (!whens.length || whens.some((w) => !['mid', 'done', 'pause', 'upstream', 'upstream-mid'].includes(w))) fail('--when takes mid, done, pause, upstream, upstream-mid, or a list of them')
if (whens.some((w) => w.startsWith('upstream')) && !upstreams.size) fail('--when upstream needs at least one --upstream name=url')
const upstreamRpm = Math.max(0, Number(opt['upstream-rpm']) || 0)
const trialGapMs = Math.max(0, Number(opt['trial-gap']) || 0) * 1000
if (opt.identity !== 'route' && opt.identity !== 'body') fail('--identity takes route or body')
const timeoutMs = Number(opt.timeout) * 1000
for (const f of ['jobs', 'samples', 'upstream-rpm', 'trial-gap', 'takeover-after'])
  if (!Number.isFinite(Number(opt[f])) || Number(opt[f]) < 0) fail(`--${f} must be a number, got "${opt[f]}"`)
const jobs = Math.max(1, Number(opt.jobs) || 1)
const samples = Math.max(1, Number(opt.samples) || 1)
const takeoverMs = Math.max(0, Number(opt['takeover-after']) || 0) * 1000
const intentFields = opt.intent.split(',').map((s) => s.trim()).filter(Boolean)
if (!(timeoutMs > 0)) fail('--timeout must be a number of seconds')
const agentCwd = resolve(opt.cwd ?? process.cwd())
const dedupe = !opt['no-dedupe']

const color = (opt.json === '-' ? process.stderr : process.stdout).isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const jsonToStdout = opt.json === '-'
const out = (s = '') => (jsonToStdout ? process.stderr : process.stdout).write(s + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10)

/** Top-level fields of a JSON or form-encoded body, for --intent. */
function fieldsOf(body) {
  try {
    const j = JSON.parse(body)
    if (j && typeof j === 'object') return j
  } catch {}
  try {
    return Object.fromEntries(new URLSearchParams(body))
  } catch {
    return {}
  }
}

const IGNORED_COLS = new Set(['id', 'at', 'ts', 'time', 'timestamp', 'created_at', 'updated_at', 'createdat', 'updatedat'])
const stable = (obj) => JSON.stringify(Object.fromEntries(Object.entries(obj).filter(([k]) => !IGNORED_COLS.has(k.toLowerCase())).sort(([a], [b]) => (a < b ? -1 : 1))))
const keyOf = (o) => (o && typeof o === 'object' ? o.idempotency_key ?? o.idempotencyKey ?? o.key ?? null : null)

// node:sqlite prints an experimental warning on first use; this tool uses it only to read.
const emitWarning = process.emitWarning
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest))

/**
 * Local stand-ins for the services the agent's tools call. Every effect becomes an "arrival". The sinks can kill the agent at one of
 * them (mid: applied but unanswered, done: answered), freeze it with that call held back (pause), or kill it at an upstream call.
 * spec = { kind: 'effect' | 'upstream' | null, k, when }.
 */
async function startSinks({ spec, kill, pause, filesDir, dbPath }) {
  const arrivals = []
  const upstreamCalls = []
  const state = { attempt: 1, killed: false, seen: 0, seenUp: 0, held: null }
  let onHeld
  const heldPromise = new Promise((r) => (onHeld = r))
  const stripe = new Map() // Idempotency-Key -> { bodyHash, reply }
  const timers = []

  const decide = (a, bodyText) => {
    if (!a.path.startsWith('/v1/')) return { status: 200, body: { ok: true, id: `sink-${a.n}` }, headers: {} }
    if (a.key && stripe.has(a.key)) {
      const prev = stripe.get(a.key)
      if (prev.bodyHash !== a.bodyHash)
        return { status: 400, body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } }, headers: {} }
      return { ...prev.reply, headers: { 'idempotent-replayed': 'true' } }
    }
    const kind = a.path.split('/')[2] ?? 'object'
    const f = fieldsOf(bodyText)
    const reply = { status: 200, body: { id: `${kind.slice(0, 2)}_${a.n}`, object: kind.replace(/s$/, ''), status: 'succeeded', amount: f.amount ?? null, livemode: false }, headers: {} }
    if (a.key) stripe.set(a.key, { bodyHash: a.bodyHash, reply })
    return reply
  }

  /** io.reply(decision, then) sends the answer; io.drop() ends the connection with no answer. blocking=false: files and rows, seen after the fact. */
  const arrive = (partial, bodyText, io, blocking = true) => {
    state.seen++
    const a = { n: 0, attempt: state.attempt, acked: false, blocking, ...partial }
    const hit = spec.kind === 'effect' && !state.killed && state.attempt === 1 && state.seen === spec.k
    const land = () => {
      a.n = arrivals.length + 1
      arrivals.push(a)
      return decide(a, bodyText)
    }
    if (hit && spec.when === 'pause') {
      state.killed = true
      if (blocking) state.held = { a, io, land, late: true }
      else {
        land()
        a.acked = true
        state.held = { a, late: false }
      }
      pause()
      onHeld(true)
      return
    }
    const decision = land()
    if (hit && spec.when === 'mid' && blocking) {
      state.killed = true
      kill()
      io.drop()
      return
    }
    io.reply(decision, () => {
      a.acked = true
      if (hit) {
        state.killed = true
        kill()
      }
    })
  }

  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      arrive(
        {
          method: req.method,
          path: new URL(req.url, 'http://sink').pathname,
          key: req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'] ?? null,
          bodyHash: hash(body),
          fields: fieldsOf(body),
        },
        body,
        {
          reply: (d, then) => {
            const text = JSON.stringify(d.body)
            res.writeHead(d.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...d.headers })
            res.end(text, then)
          },
          drop: () => req.socket.destroy(),
        },
      )
    })
  })

  // A small SMTP server: it accepts any mail and records one arrival per message, as it ends DATA.
  const smtpServer = net.createServer((sock) => {
    let buf = ''
    let rcpt = []
    let inData = false
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.write('220 crash-test ESMTP\r\n')
    const handleLine = (line) => {
      const cmd = line.slice(0, 4).toUpperCase()
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 crash-test\r\n')
      else if (cmd === 'MAIL') {
        rcpt = []
        sock.write('250 ok\r\n')
      } else if (cmd === 'RCPT') {
        rcpt.push((/<([^>]*)>/.exec(line)?.[1] ?? line.slice(8)).trim().toLowerCase())
        sock.write('250 ok\r\n')
      } else if (cmd === 'DATA') {
        inData = true
        sock.write('354 end with <CRLF>.<CRLF>\r\n')
      } else if (cmd === 'QUIT') {
        sock.write('221 bye\r\n')
        sock.end()
      } else sock.write('250 ok\r\n')
    }
    sock.on('data', (chunk) => {
      buf += chunk
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          const message = buf.slice(0, end)
          buf = buf.slice(end + 5)
          inData = false
          const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(message)?.[1]?.trim() ?? null
          const bodyText = message.split(/\r\n\r\n/).slice(1).join('\r\n\r\n')
          arrive(
            {
              method: 'SMTP',
              path: `to:${rcpt.join(',')}`,
              key: header('x-idempotency-key') ?? header('message-id'),
              bodyHash: hash(message.replace(/^(date|message-id):.*\r?\n/gim, '')),
              fields: { to: rcpt.join(','), subject: header('subject') },
            },
            bodyText,
            { reply: (_d, then) => sock.write('250 queued\r\n', then), drop: () => sock.destroy() },
          )
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        handleLine(line)
      }
    })
  })

  // Files: every complete line appended under filesDir is an effect. Seen after the fact, so the answer is immediate.
  const offsets = new Map()
  const pending = new Map()
  const nonBlocking = { reply: (_d, then) => then(), drop: () => {} }
  const scanFiles = (dir, rel = '') => {
    let names = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) scanFiles(join(dir, e.name), r)
      else if (e.isFile()) readNew(join(dir, e.name), r)
    }
  }
  const readNew = (path, rel) => {
    let size
    try {
      size = statSync(path).size
    } catch {
      return
    }
    let off = offsets.get(rel) ?? 0
    if (size < off) off = 0
    if (size === off) return
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - off)
    readSync(fd, buf, 0, buf.length, off)
    closeSync(fd)
    let text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) {
      // No newline yet: take it as a line once the file stops growing (a file written whole).
      if (pending.get(rel) !== size) return void pending.set(rel, size)
      pending.delete(rel)
      offsets.set(rel, size)
    } else {
      text = text.slice(0, lastNl + 1)
      offsets.set(rel, off + Buffer.byteLength(text))
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {}
      arrive(
        { method: 'FILE', path: rel, key: keyOf(obj), bodyHash: hash(obj && typeof obj === 'object' ? stable(obj) : line), fields: obj && typeof obj === 'object' ? obj : {} },
        line,
        nonBlocking,
        false,
      )
    }
  }
  timers.push(setInterval(() => scanFiles(filesDir), 5))

  // Database rows: SQLite, insert-only, polled. A row is an effect once it is committed.
  let db = null
  let sqlite = null
  const lastRow = new Map()
  // Create the file in WAL mode first, so the tool's reads never block the agent's writes.
  try {
    sqlite = await import('node:sqlite')
    const seed = new sqlite.DatabaseSync(dbPath)
    seed.exec('pragma journal_mode = wal')
    seed.close()
  } catch {
    sqlite = null
  }
  const pollDb = async () => {
    if (!existsSync(dbPath)) return
    try {
      if (!sqlite) return
      if (!db) {
        db = new sqlite.DatabaseSync(dbPath)
        db.exec('pragma busy_timeout = 50; pragma query_only = 1')
      }
      const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all()
      for (const { name } of tables) {
        const after = lastRow.get(name) ?? 0
        const rows = db.prepare(`select rowid as __rowid, * from "${name}" where rowid > ? order by rowid limit 200`).all(after)
        for (const row of rows) {
          lastRow.set(name, row.__rowid)
          const { __rowid, ...cols } = row
          arrive({ method: 'INSERT', path: name, key: keyOf(cols), bodyHash: hash(stable(cols)), fields: cols }, JSON.stringify(cols), nonBlocking, false)
        }
      }
    } catch {
      // The file may not be a database yet, or be locked for a moment. Try again on the next tick.
    }
  }
  let polling = false
  timers.push(
    setInterval(async () => {
      if (polling) return
      polling = true
      await pollDb()
      polling = false
    }, 5),
  )

  // Upstream pass-throughs: forwarded as they are, counted, and a place to kill. They are not effects.
  const slot = { next: 0 }
  const throttle = async () => {
    if (!upstreamRpm) return
    const gap = 60000 / upstreamRpm
    const at = Math.max(Date.now(), slot.next)
    slot.next = at + gap
    if (at > Date.now()) await sleep(at - Date.now())
  }
  const proxyServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const m = /^\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url)
      const base = m && upstreams.get(m[1])
      if (!base) {
        res.writeHead(404).end('unknown upstream')
        return
      }
      await throttle()
      state.seenUp++
      const j = state.seenUp
      const hit = spec.kind === 'upstream' && !state.killed && state.attempt === 1 && j === spec.k
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection', 'accept-encoding'].includes(k)))
      let r
      try {
        r = await fetch(base + (m[2] ?? '') + (m[3] ?? ''), { method: req.method, headers: { ...headers, 'accept-encoding': 'identity' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
      } catch (e) {
        res.writeHead(502).end(`upstream error: ${e}`)
        return
      }
      const buf = Buffer.from(await r.arrayBuffer())
      upstreamCalls.push({ n: j, attempt: state.attempt, name: m[1], path: m[2] ?? '/', status: r.status })
      const out = Object.fromEntries([...r.headers].filter(([k]) => !['transfer-encoding', 'content-length', 'content-encoding', 'connection'].includes(k)))
      if (hit && spec.when === 'upstream-mid') {
        state.killed = true
        kill()
        req.socket.destroy()
        return
      }
      res.writeHead(r.status, { ...out, 'content-length': buf.length })
      res.end(buf, () => {
        if (hit) {
          state.killed = true
          kill()
        }
      })
    })
  })

  await new Promise((ok) => httpServer.listen(0, '127.0.0.1', ok))
  await new Promise((ok) => smtpServer.listen(0, '127.0.0.1', ok))
  await new Promise((ok) => proxyServer.listen(0, '127.0.0.1', ok))
  const smtpPort = smtpServer.address().port
  const proxyPort = proxyServer.address().port
  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    smtp: { host: '127.0.0.1', port: smtpPort, url: `smtp://127.0.0.1:${smtpPort}` },
    upstreamUrls: Object.fromEntries([...upstreams.keys()].map((n) => [n, `http://127.0.0.1:${proxyPort}/${n}`])),
    arrivals,
    upstreamCalls,
    state,
    heldPromise,
    setKill: (fn) => (kill = fn),
    setPause: (fn) => (pause = fn),
    /** Let the frozen call through: if it had been held back, it lands now as a late arrival. */
    release: () => {
      const h = state.held
      if (!h) return
      state.held = null
      state.attempt = 3
      if (!h.late) return
      const decision = h.land()
      h.a.attempt = 3
      h.io.reply(decision, () => (h.a.acked = true))
    },
    close: () => {
      timers.forEach(clearInterval)
      for (const s of [httpServer, proxyServer]) {
        s.close()
        s.closeAllConnections?.()
      }
      smtpServer.close()
      try {
        db?.close()
      } catch {}
    },
  }
}

/** Run the agent command in its own process group so a kill takes its children too. */
function runAgent({ cwd, env, logPath }) {
  const fd = opt.verbose ? 'inherit' : openSync(logPath, 'a')
  const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: opt.verbose ? (jsonToStdout ? ['ignore', 2, 2] : 'inherit') : ['ignore', fd, fd] })
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig)
    } catch {}
  }
  const done = new Promise((ok) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGCONT')
      signal('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code, sig) => {
      clearTimeout(timer)
      if (fd !== 'inherit') closeSync(fd)
      ok({ code, signal: sig, timedOut })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      ok({ code: 127, signal: null, timedOut: false, error: String(e) })
    })
  })
  return { kill: () => signal('SIGKILL'), freeze: () => signal('SIGSTOP'), thaw: () => signal('SIGCONT'), done }
}

const intentOf = (a) => (intentFields.length ? ' [' + intentFields.map((f) => `${f}=${a.fields?.[f] ?? ''}`).join(' ') + ']' : '')
const group = (a) => `${a.method} ${a.path}${opt.identity === 'body' ? ` #${a.bodyHash}` : ''}${intentOf(a)}`
const label = (a) => `${a.method} ${a.path}${intentOf(a)}`

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

function agentEnv(sinks, dir, trial) {
  const up = Object.fromEntries(Object.entries(sinks.upstreamUrls).map(([n, u]) => [`CRASHTEST_UPSTREAM_${n.toUpperCase().replace(/-/g, '_')}_URL`, u]))
  return {
    ...process.env,
    CRASHTEST_SINK_URL: sinks.url,
    CRASHTEST_SMTP_URL: sinks.smtp.url,
    CRASHTEST_SMTP_HOST: sinks.smtp.host,
    CRASHTEST_SMTP_PORT: String(sinks.smtp.port),
    CRASHTEST_FILES_DIR: dir.filesDir,
    CRASHTEST_DB_PATH: dir.dbPath,
    CRASHTEST_STATE_DIR: dir.stateDir,
    CRASHTEST_TRIAL: String(trial),
    ...up,
  }
}

function prepareDir(label) {
  const root = mkdtempSync(join(tmpdir(), `crash-test-${label}-`))
  const stateDir = join(root, 'state')
  const filesDir = join(root, 'files')
  mkdirSync(stateDir)
  mkdirSync(filesDir)
  let cwd = agentCwd
  if (opt['copy-cwd']) {
    cwd = join(root, 'cwd')
    cpSync(agentCwd, cwd, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git)$/.test(src) })
    if (existsSync(join(agentCwd, 'node_modules'))) symlinkSync(join(agentCwd, 'node_modules'), join(cwd, 'node_modules'))
  }
  return { root, stateDir, filesDir, dbPath: join(root, 'crash-test.sqlite'), cwd, logPath: join(root, 'agent.log') }
}

async function cleanRun(i) {
  const dir = prepareDir(`clean${i}`)
  const sinks = await startSinks({ spec: { kind: null }, kill: () => {}, pause: () => {}, filesDir: dir.filesDir, dbPath: dir.dbPath })
  const run = runAgent({ cwd: dir.cwd, env: agentEnv(sinks, dir, 0), logPath: dir.logPath })
  const res = await run.done
  await sleep(30) // let the file and row watchers see the last write
  sinks.close()
  if (!opt.keep) rmSync(dir.root, { recursive: true, force: true })
  return { res, arrivals: sinks.arrivals, upstreamCalls: sinks.upstreamCalls }
}

const whenLabel = { mid: 'mid', done: 'done', pause: 'pause', upstream: 'after reply', 'upstream-mid': 'reply lost' }

async function trial(spec, expected, expectedMin, plans, n) {
  const dir = prepareDir(`${spec.kind}${spec.k}-${spec.when}`)
  const sinks = await startSinks({ spec, kill: () => {}, pause: () => {}, filesDir: dir.filesDir, dbPath: dir.dbPath })
  const env = agentEnv(sinks, dir, n)
  const first = runAgent({ cwd: dir.cwd, env, logPath: dir.logPath })
  sinks.setKill(first.kill)
  sinks.setPause(first.freeze)
  const early = await Promise.race([first.done.then((r) => ({ exited: r })), sinks.heldPromise.then(() => ({ held: true }))])
  const r = { ...spec, verdict: 'ok', issues: [], arrivals: sinks.arrivals, diverged: null }
  if (early.exited && !sinks.state.killed) {
    sinks.close()
    r.verdict = 'not-reached'
    r.note = `the agent finished (exit ${early.exited.code}) before reaching ${spec.kind === 'upstream' ? `upstream call #${spec.k}` : `call #${spec.k}`}`
    if (!opt.keep) rmSync(dir.root, { recursive: true, force: true })
    return r
  }
  if (early.held) {
    // The frozen copy is still alive. Start the restart while it is frozen, then let the frozen one carry on.
    if (takeoverMs) await sleep(takeoverMs)
    sinks.state.attempt = 2
    const second = runAgent({ cwd: dir.cwd, env, logPath: dir.logPath })
    r.secondRun = await second.done
    sinks.release()
    first.thaw()
    r.firstRun = await first.done
  } else {
    r.firstRun = early.exited ?? (await first.done)
    sinks.state.attempt = 2
    const second = runAgent({ cwd: dir.cwd, env, logPath: dir.logPath })
    r.secondRun = await second.done
  }
  await sleep(30)
  sinks.close()

  const firstCalls = sinks.arrivals.filter((a) => a.attempt === 1)
  const heldCall = early.held ? sinks.arrivals.find((a) => a.attempt === 3) : null
  r.diverged = divergence(heldCall ? [...firstCalls, heldCall] : firstCalls, plans)
  const got = tally(sinks.arrivals)
  for (const g of new Set([...expected.keys(), ...got.keys()])) {
    const known = expected.get(g)
    const want = known?.applied ?? (r.diverged ? 1 : 0)
    const wantMin = expectedMin.get(g) ?? 0
    const t = got.get(g) ?? { applied: 0, replays: 0, arrivals: 0, firstAcked: null }
    if (t.applied > want) r.issues.push({ kind: 'duplicated', action: g, expected: want, applied: t.applied, replays: t.replays, firstAcked: t.firstAcked })
    else if (t.applied < wantMin && !r.diverged) r.issues.push({ kind: 'lost', action: g, expected: wantMin, applied: t.applied })
    else if (t.replays) r.issues.push({ kind: 'replayed', action: g, expected: want, applied: t.applied, replays: t.replays, firstAcked: t.firstAcked })
  }
  const bad = r.issues.filter((i) => i.kind === 'duplicated' || i.kind === 'lost')
  const restart = r.secondRun
  if (restart.timedOut || restart.code !== 0) {
    r.verdict = 'incomplete'
    r.note = restart.timedOut ? 'the restarted agent hit the timeout' : `the restarted agent exited with code ${restart.code}`
  } else if (bad.length) {
    const d = bad.some((i) => i.kind === 'duplicated')
    const l = bad.some((i) => i.kind === 'lost')
    r.verdict = d && l ? 'duplicated+lost' : d ? 'duplicated' : 'lost'
  } else if (r.diverged) {
    r.verdict = 'diverged'
  }
  if (r.diverged) r.note = `path diverged at call ${r.diverged.at}: the clean run made ${r.diverged.clean}, this run made ${r.diverged.saw}`
  if (!opt.keep && r.verdict !== 'incomplete') rmSync(dir.root, { recursive: true, force: true })
  else r.keptAt = dir.root
  return r
}

/** The first place the trial's own opening calls differ from every clean run. */
function divergence(firstCalls, plans) {
  const ids = firstCalls.map(group)
  if (plans.some((p) => ids.every((g, i) => p[i] === g))) return null
  const best = plans.map((p) => {
    let i = 0
    while (i < ids.length && p[i] === ids[i]) i++
    return { i, p }
  }).sort((x, y) => y.i - x.i)[0]
  return { at: best.i + 1, saw: ids[best.i], clean: best.p[best.i] ?? '(the clean run had ended)' }
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

async function main() {
  out(bold('crash-test'))
  out(dim(`agent: ${command}`))
  out(dim(`identity: ${opt.identity}${intentFields.length ? ` + ${intentFields.join(',')}` : ''}, dedupe on Idempotency-Key: ${dedupe ? 'yes' : 'no'}${upstreams.size ? `, upstream: ${[...upstreams.keys()].join(',')}` : ''}`))
  out()

  const runs = []
  const upRuns = []
  for (let i = 1; i <= samples; i++) {
    const c = await cleanRun(i)
    if (c.res.timedOut || c.res.code !== 0) {
      console.error(red(`The agent did not finish a clean run (${c.res.timedOut ? 'timeout' : `exit ${c.res.code}`}). Fix that first.`))
      if (c.arrivals.length === 0) console.error('It made no calls to the sinks either. Point its tools at $CRASHTEST_SINK_URL, $CRASHTEST_SMTP_URL, $CRASHTEST_FILES_DIR or $CRASHTEST_DB_PATH.')
      if (!opt.verbose) console.error(dim('Run with --verbose to see its output.'))
      process.exit(2)
    }
    runs.push(c.arrivals)
    upRuns.push(c.upstreamCalls)
    if (trialGapMs && i < samples) await sleep(trialGapMs)
  }
  const longest = (rs) => rs.reduce((best, r) => (r.length > best.length ? r : best), rs[0])
  const calls = longest(runs)
  const upCalls = longest(upRuns)
  if (!calls.length) {
    console.error(red('The agent finished but nothing reached the sinks, so there is nothing to kill it at.'))
    console.error('Point its tools at $CRASHTEST_SINK_URL, $CRASHTEST_SMTP_URL, $CRASHTEST_FILES_DIR or $CRASHTEST_DB_PATH.')
    process.exit(2)
  }
  const plans = runs.map((r) => r.map(group))
  const expected = new Map()
  for (const r of runs)
    for (const [g, t] of tally(r)) if (!expected.has(g) || expected.get(g).applied < t.applied) expected.set(g, t)
  // An action counts as "lost" only if every clean run did it; a duplicate is measured against the most any clean run did.
  const expectedMin = new Map([...expected.keys()].map((g) => [g, Math.min(...runs.map((r) => tally(r).get(g)?.applied ?? 0))]))

  const nPaths = new Set(plans.map((p) => p.join('|'))).size
  out(`Clean run${samples > 1 ? 's' : ''}: ${calls.length} effect${calls.length === 1 ? '' : 's'}${upCalls.length ? `, ${upCalls.length} upstream call${upCalls.length === 1 ? '' : 's'}` : ''}${samples > 1 ? ` (longest of ${samples}; ${nPaths} distinct path${nPaths === 1 ? '' : 's'})` : ''}`)
  calls.forEach((a) => out(`  #${a.n} ${label(a)}${a.key ? dim(`  key ${a.key}`) : dim('  no key')}`))
  if (upCalls.length) upCalls.forEach((u) => out(dim(`  upstream #${u.n} ${u.name} ${u.path}`)))
  out()

  const only = opt['kill-at'] === 'all' ? null : new Set(opt['kill-at'].split(',').map(Number))
  if (only && [...only].some((k) => !Number.isInteger(k) || k < 1 || k > calls.length)) fail(`--kill-at must be between 1 and ${calls.length}`)
  const onlyUp = opt['kill-upstream-at'] === 'all' ? null : new Set(opt['kill-upstream-at'].split(',').map(Number))
  const plan = []
  for (let k = 1; k <= calls.length; k++) {
    if (only && !only.has(k)) continue
    const blocking = calls[k - 1].blocking
    const modes = ['mid', 'done', 'pause'].filter((w) => whens.includes(w))
    // Files and rows are seen after the fact, so "mid" would be the same kill as "done".
    for (const w of modes) if (!(w === 'mid' && !blocking && modes.includes('done'))) plan.push({ kind: 'effect', k, when: w, call: calls[k - 1] })
  }
  for (const u of upCalls) {
    if (onlyUp && !onlyUp.has(u.n)) continue
    for (const w of ['upstream', 'upstream-mid']) if (whens.includes(w)) plan.push({ kind: 'upstream', k: u.n, when: w, call: { method: 'MODEL', path: `${u.name} reply #${u.n}`, fields: {} } })
  }
  out(`Killing at ${plan.length} point${plan.length === 1 ? '' : 's'}, restarting each time...`)
  out()

  const results = await pool(plan, jobs, async (p, i) => {
    if (trialGapMs && i > 0 && jobs === 1) await sleep(trialGapMs)
    const r = await trial({ kind: p.kind, k: p.k, when: p.when }, expected, expectedMin, plans, i + 1)
    r.call = p.call
    return r
  })

  const sym = { ok: green('✓'), 'not-reached': dim('–'), diverged: yellow('~'), incomplete: yellow('!'), duplicated: red('✗'), lost: red('✗'), 'duplicated+lost': red('✗') }
  for (const r of results) {
    const head = `${sym[r.verdict]} ${whenLabel[r.when].padEnd(11)} at #${r.k} ${label(r.call).padEnd(34)}`
    const detail = [
      ...r.issues.filter((i) => i.kind === 'duplicated').map((i) => `${i.action} landed ${i.applied}× (expected ${i.expected})${r.when === 'pause' ? ', the frozen copy landing after the restart had done it' : i.firstAcked ? ', after the first one was acknowledged' : ', after the first one was cut off'}`),
      ...r.issues.filter((i) => i.kind === 'lost').map((i) => `${i.action} never landed`),
      ...r.issues.filter((i) => i.kind === 'replayed').map((i) => `${i.action} came again with the same key (${i.replays}×), absorbed`),
      ...(r.note ? [r.note] : []),
    ]
    out(`${head} ${detail.length ? detail.join('; ') : dim('every action landed once')}`)
  }

  const actions = summarizeActions(expected, results)
  if (actions.length) {
    out()
    out(bold('By action'))
    const w = Math.max(6, ...actions.map((a) => a.action.length))
    const cell = (a) => (a.repeatedIn ? 'REPEATED' : a.lostIn ? 'LOST' : a.replayedIn ? 'ok (same-key replays)' : 'ok')
    out(`  ${'Action'.padEnd(w)}  ${'Clean run'.padEnd(9)}  ${'Worst'.padEnd(5)}  ${'Repeated in'.padEnd(11)}  Verdict`)
    for (const a of actions) {
      const verdict = cell(a)
      const painted = a.repeatedIn || a.lostIn ? red(verdict) : green(verdict)
      out(`  ${a.action.padEnd(w)}  ${`${a.expected}×`.padEnd(9)}  ${`${a.worst}×`.padEnd(5)}  ${`${a.repeatedIn} of ${results.length}`.padEnd(11)}  ${painted}`)
    }
  }

  const count = (v) => results.filter((r) => r.verdict === v).length
  const dup = results.filter((r) => r.verdict.startsWith('duplicated')).length
  const lost = results.filter((r) => r.verdict.endsWith('lost')).length
  const incomplete = count('incomplete')
  const diverged = results.filter((r) => r.diverged).length
  const replayed = results.filter((r) => r.issues.some((i) => i.kind === 'replayed')).length
  const exercised = results.filter((r) => r.verdict !== 'not-reached').length
  out()
  out(bold('Result'))
  out(`  kill points exercised:           ${exercised} of ${plan.length}`)
  out(`  trials with a duplicated effect: ${dup === 0 ? green(dup) : red(dup)}`)
  out(`  trials with a lost effect:       ${lost === 0 ? green(lost) : red(lost)}`)
  if (replayed) out(`  trials with an absorbed replay:  ${replayed} ${dim('(same Idempotency-Key; safe if the receiver dedupes on it)')}`)
  if (diverged) out(`  trials where the path diverged:  ${yellow(diverged)} ${dim('(the agent chose other calls than the clean run; lost work is not checked there)')}`)
  if (incomplete) out(`  trials that did not finish:      ${yellow(incomplete)}`)
  const failing = dup + lost > 0
  if (dup > 0) {
    out()
    out(dim('A repeated action is harmless only if the receiver can tell it has seen it before. Send a stable Idempotency-Key with each action, built from the thing it acts on (the order, the ticket), and make the receiver honour it.'))
  }
  if (failing && !opt['no-promo']) {
    out()
    out(dim('Or run it on Argentic: a killed agent resumes without repeating a finished action. https://getargentic.com'))
  }
  if (opt.demo) {
    out()
    out(dim('That was a bundled demo agent. To test yours, point its tool calls at $CRASHTEST_SINK_URL and run: crash-test -- <your command>'))
  }

  const report = {
    tool: 'crash-test',
    version,
    command,
    identity: opt.identity,
    intent: intentFields,
    dedupe,
    samples,
    upstreams: [...upstreams.keys()],
    cleanRun: calls.map((a) => ({ n: a.n, action: label(a), key: a.key })),
    summary: { planned: plan.length, exercised, duplicated: dup, lost, replayed, diverged, incomplete },
    actions,
    exitCode: failing ? 1 : incomplete ? 2 : 0,
    trials: results.map((r) => ({
      kind: r.kind,
      killAt: r.k,
      when: r.when,
      call: label(r.call),
      verdict: r.verdict,
      issues: r.issues,
      diverged: r.diverged,
      note: r.note ?? null,
      arrivals: r.arrivals.map((a) => ({ n: a.n, attempt: a.attempt, action: label(a), key: a.key, acked: a.acked })),
      keptAt: r.keptAt ?? null,
    })),
  }
  if (jsonToStdout) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2) + '\n')
  if (opt.md) writeFileSync(opt.md, markdown(report))
  process.exit(failing ? 1 : incomplete ? 2 : 0)
}

/** One row per action: what the clean run did, the worst a kill point made of it, and in how many trials it repeated or went missing. */
function summarizeActions(expected, results) {
  const rows = new Map([...expected].map(([action, t]) => [action, { action, expected: t.applied, worst: t.applied, repeatedIn: 0, lostIn: 0, replayedIn: 0 }]))
  const row = (action) => rows.get(action) ?? rows.set(action, { action, expected: 0, worst: 0, repeatedIn: 0, lostIn: 0, replayedIn: 0 }).get(action)
  for (const r of results)
    for (const i of r.issues) {
      const a = row(i.action)
      if (i.kind === 'duplicated') {
        a.repeatedIn++
        a.worst = Math.max(a.worst, i.applied)
      } else if (i.kind === 'lost') a.lostIn++
      else if (i.kind === 'replayed') a.replayedIn++
    }
  return [...rows.values()]
}

function markdown(r) {
  const rows = r.trials.map((t) => {
    const what = t.issues
      .filter((i) => i.kind === 'duplicated' || i.kind === 'lost')
      .map((i) => (i.kind === 'duplicated' ? `\`${i.action}\` landed ${i.applied}× (expected ${i.expected})` : `\`${i.action}\` never landed`))
      .join('; ')
    return `| ${t.killAt} | ${t.when} | \`${t.call}\` | ${t.verdict} | ${what || t.note || ''} |`
  })
  return [
    '# crash-test report',
    '',
    `Agent: \`${r.command}\``,
    '',
    `Kill points exercised: ${r.summary.exercised} of ${r.summary.planned}. Trials with a duplicated effect: ${r.summary.duplicated}. With a lost effect: ${r.summary.lost}. Path diverged: ${r.summary.diverged}. Did not finish: ${r.summary.incomplete}.`,
    '',
    '| Action | Clean run | Worst | Repeated in | Lost in | Same-key replays in |',
    '|---|---|---|---|---|---|',
    ...r.actions.map((a) => `| \`${a.action}\` | ${a.expected}× | ${a.worst}× | ${a.repeatedIn} of ${r.trials.length} | ${a.lostIn} | ${a.replayedIn} |`),
    '',
    '| Kill at call | When | Call | Verdict | What happened |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

await main()
