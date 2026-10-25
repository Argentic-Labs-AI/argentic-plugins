// Checks that crash-test's verdict depends on the agent: plain loops must be caught, keyed ones must pass, the same keyed agent must
// fail when the receiver does not honour keys, and a broken restart must be reported as lost work. Covers the HTTP, payments, SMTP,
// file and SQLite sinks, pause mode, and kills around a model call (against a scripted model).
// Run: node test/self-test.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModel } from './fake-model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'crash-test.mjs')
const ex = (f) => join(root, 'examples', f)
const hasSqlite = await import('node:sqlite').then(() => true, () => false)
const model = await startFakeModel()
// The AI SDK examples need `npm install` in examples/ai-sdk (the tests never touch the network, so they do not install it themselves).
const hasAiSdk = existsSync(join(root, 'examples', 'ai-sdk', 'node_modules', 'ai'))
const hasPython = await new Promise((ok) => spawn('python3', ['--version']).on('error', () => ok(false)).on('exit', (c) => ok(c === 0)))
const aiSdk = (f) => ['node', join(root, 'examples', 'ai-sdk', f)]
const scratch = mkdtempSync(join(tmpdir(), 'crash-test-selftest-'))

const cases = [
  { name: 'plain loop is caught repeating finished actions', cmd: ['node', ex('plain-agent.mjs')], exit: 1, text: /landed 2×/ },
  { name: 'keyed + checkpointed agent passes when the receiver dedupes on the key', cmd: ['node', ex('keyed-agent.mjs')], exit: 0, text: /duplicated effect: .*0/ },
  { name: 'the same agent fails when the receiver ignores keys', cmd: ['node', ex('keyed-agent.mjs')], args: ['--no-dedupe'], exit: 1, text: /landed 2×/ },
  { name: 'a restart that skips work is reported as lost', cmd: ['node', ex('lossy-agent.mjs')], exit: 1, text: /never landed/ },
  { name: 'a checkpoint file with no key still duplicates the cut-off action', cmd: ['node', ex('checkpoint-agent.mjs')], exit: 1, text: /cut off/ },
  { name: 'a frozen copy that wakes up late is caught (pause)', cmd: ['node', ex('plain-agent.mjs')], args: ['--when', 'pause'], exit: 1, text: /frozen copy/ },
  { name: 'a keyed agent survives a frozen copy waking up late', cmd: ['node', ex('keyed-agent.mjs')], args: ['--when', 'pause'], exit: 0, text: /duplicated effect: .*0/ },
  { name: 'SMTP: a mail sent twice is caught', cmd: ['node', ex('mail-agent.mjs')], args: ['--intent', 'subject'], exit: 1, text: /SMTP to:dana@example.com/ },
  { name: 'SMTP: a stable key on the message passes', cmd: ['node', ex('mail-agent.mjs')], args: ['--intent', 'subject'], env: { SMTP_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'payments API without an Idempotency-Key duplicates the refund', cmd: ['node', ex('payments-agent.mjs')], exit: 1, text: /\/v1\/refunds landed 2×/ },
  { name: 'payments API with the key passes', cmd: ['node', ex('payments-agent.mjs')], env: { PAY_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'a keyed agent that takes other routes passes and reports the divergence', cmd: ['node', ex('wandering-agent.mjs')], args: ['--samples', '4'], env: { WANDER_KEYED: '1', WANDER_SEQ_FILE: join(scratch, 'wander-keyed.seq') }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'an unkeyed agent that takes other routes is still caught', cmd: ['node', ex('wandering-agent.mjs')], args: ['--samples', '4'], env: { WANDER_SEQ_FILE: join(scratch, 'wander-unkeyed.seq') }, exit: 1, text: /landed 2×/ },
  { name: 'an action no clean run made, landing once after a restart, is a different route and not a repeat', cmd: ['node', join(root, 'test', 'restart-extra-agent.mjs')], exit: 0, text: /POST \/c landed once, but no clean run made it/ },
  { name: 'file sink: a line appended twice is caught', cmd: ['node', ex('file-agent.mjs')], args: ['--intent', 'tool'], exit: 1, text: /FILE outbox.jsonl \[tool=refund_order\] landed 2×/ },
  { name: 'file sink: a stable key in the line passes', cmd: ['node', ex('file-agent.mjs')], args: ['--intent', 'tool'], env: { FILE_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  ...(hasSqlite
    ? [
        { name: 'database sink: a row inserted twice is caught', cmd: ['node', '--no-warnings', ex('db-agent.mjs')], exit: 1, text: /INSERT refunds landed 2×/ },
        { name: 'database sink: a unique key makes the second insert a no-op', cmd: ['node', '--no-warnings', ex('db-agent.mjs')], env: { DB_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
      ]
    : []),
  ...(hasAiSdk
    ? [
        { name: 'AI SDK agent that just calls its tools is caught repeating every action', cmd: aiSdk('naive.mjs'), exit: 1, text: /POST \/refund_order landed 2×/ },
        { name: 'the same AI SDK agent with an Idempotency-Key per action passes', cmd: aiSdk('safe.mjs'), exit: 0, text: /duplicated effect: .*0/ },
        { name: 'the safe AI SDK agent fails against a receiver that ignores keys', cmd: aiSdk('safe.mjs'), args: ['--no-dedupe'], exit: 1, text: /landed 2×/ },
      ]
    : []),
  ...(hasPython
    ? [{ name: 'a plain Python agent is caught too (any language works)', cmd: ['python3', ex('python-agent.py')], exit: 1, text: /POST \/refund_order landed 2×/ }]
    : []),
  { name: 'report has a by-action table', cmd: ['node', ex('plain-agent.mjs')], exit: 1, text: /By action\n\s+Action\s+Clean run\s+Worst\s+Repeated in\s+Verdict\n\s+POST \/refund_order\s+1×\s+2×\s+6 of 6\s+REPEATED/ },
  { name: 'kill between a model reply and its tool call: a plain LLM loop repeats the refund', cmd: ['node', ex('llm-agent.mjs')], args: ['--upstream', `model=${model.url}`, '--when', 'upstream'], exit: 1, text: /after reply.*POST \/refund_order landed 2×/ },
  { name: 'kill between a model reply and its tool call: a keyed LLM loop is clean', cmd: ['node', ex('llm-agent.mjs')], args: ['--upstream', `model=${model.url}`, '--when', 'upstream,upstream-mid'], env: { LLM_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
]

const run = (c) =>
  new Promise((ok) => {
    const p = spawn('node', [cli, '--no-promo', ...(c.args ?? []), '--', ...c.cmd], { env: { ...process.env, NO_COLOR: '1', ...(c.env ?? {}) } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('exit', (status) => ok({ status, stdout, stderr }))
  })

// CLI behaviour: help, version, setup errors, the closing line, and the JSON report.
const cli_ = (args, env = {}) =>
  new Promise((ok) => {
    const p = spawn('node', [cli, ...args], { env: { ...process.env, NO_COLOR: '1', ...env } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('exit', (status) => ok({ status, stdout, stderr }))
  })
const jsonFile = join(scratch, 'report.json')
const cliCases = [
  { name: '--help prints usage and exits 0', run: () => cli_(['--help']), check: (r) => r.status === 0 && /Usage:/.test(r.stdout) && /--json <file\|->/.test(r.stdout) },
  { name: '--version prints the package version and exits 0', run: () => cli_(['--version']), check: (r) => r.status === 0 && r.stdout.trim() === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version },
  { name: 'no agent command is a setup error (exit 2)', run: () => cli_([]), check: (r) => r.status === 2 && /no agent command/.test(r.stderr) },
  { name: 'a bad number is a setup error (exit 2)', run: () => cli_(['--samples', 'many', '--', 'true']), check: (r) => r.status === 2 && /--samples must be a number/.test(r.stderr) },
  { name: 'an agent that never reaches a sink is a setup error (exit 2)', run: () => cli_(['--', 'node', '-e', '0']), check: (r) => r.status === 2 && /nothing reached the sinks/.test(r.stderr) },
  { name: 'a failing report ends with the Argentic line', run: () => cli_(['--', ...cmdOf('plain-agent.mjs')]), check: (r) => r.status === 1 && r.stdout.trimEnd().split('\n').pop().startsWith('Or run it on Argentic') },
  { name: '--no-promo removes the Argentic line', run: () => cli_(['--no-promo', '--', ...cmdOf('plain-agent.mjs')]), check: (r) => r.status === 1 && !/Argentic/.test(r.stdout) },
  { name: 'a passing report has no Argentic line', run: () => cli_(['--', ...cmdOf('keyed-agent.mjs')]), check: (r) => r.status === 0 && !/Argentic/.test(r.stdout) },
  { name: '--demo runs the bundled agent, catches it, and points to the next step', run: () => cli_(['--demo']), check: (r) => r.status === 1 && /landed 2×/.test(r.stdout) && /bundled demo agent/.test(r.stdout) && /Or run it on Argentic/.test(r.stdout) },
  { name: '--demo with a command is a setup error (exit 2)', run: () => cli_(['--demo', '--', 'true']), check: (r) => r.status === 2 && /--demo runs the bundled agent/.test(r.stderr) },
  {
    name: '--json <file> writes a report with a summary, per-action rows and the exit code',
    run: async () => ({ ...(await cli_(['--no-promo', '--json', jsonFile, '--', ...cmdOf('plain-agent.mjs')])), json: JSON.parse(readFileSync(jsonFile, 'utf8')) }),
    check: (r) => r.status === 1 && r.json.exitCode === 1 && r.json.summary.duplicated === 6 && r.json.actions.length === 3 && r.json.actions[0].repeatedIn === 6 && r.json.trials.length === 6 && /^\d+\.\d+\.\d+/.test(r.json.version),
  },
  {
    name: '--json - puts only JSON on stdout and the readable report on stderr',
    run: async () => {
      const r = await cli_(['--no-promo', '--json', '-', '--', ...cmdOf('keyed-agent.mjs')])
      return { ...r, json: JSON.parse(r.stdout) }
    },
    check: (r) => r.status === 0 && r.json.exitCode === 0 && r.json.summary.duplicated === 0 && /By action/.test(r.stderr),
  },
]
function cmdOf(f) {
  return ['node', ex(f)]
}

let bad = 0
for (const c of cliCases) {
  let ok = false
  let r
  try {
    r = await c.run()
    ok = c.check(r)
  } catch (e) {
    r = { stdout: '', stderr: String(e) }
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}`)
  if (!ok) {
    bad++
    console.log(r.stdout, r.stderr)
  }
}
if (!hasAiSdk) console.log('skip AI SDK examples: run `npm install` in examples/ai-sdk to include them')
for (const c of cases) {
  const r = await run(c)
  const ok = r.status === c.exit && c.text.test(r.stdout)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, wanted ${c.exit})`)
  if (!ok) {
    bad++
    console.log(r.stdout, r.stderr)
  }
}
model.close()
rmSync(scratch, { recursive: true, force: true })
console.log(bad ? `${bad} failed` : `${cases.length + cliCases.length} passed`)
process.exit(bad ? 1 : 0)
