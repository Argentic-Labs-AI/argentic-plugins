// Checks that crash-test's verdict depends on the agent: plain loops must be caught, keyed ones must pass, the same keyed agent must
// fail when the receiver does not honour keys, and a broken restart must be reported as lost work. Covers the HTTP, payments, SMTP,
// file and SQLite sinks, pause mode, and kills around a model call (against a scripted model).
// Run: node test/self-test.mjs
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModel } from './fake-model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'crash-test.mjs')
const ex = (f) => join(root, 'examples', f)
const hasSqlite = await import('node:sqlite').then(() => true, () => false)
const model = await startFakeModel()

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
  { name: 'a keyed agent that takes other routes passes and reports the divergence', cmd: ['node', ex('wandering-agent.mjs')], args: ['--samples', '4'], env: { WANDER_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'an unkeyed agent that takes other routes is still caught', cmd: ['node', ex('wandering-agent.mjs')], args: ['--samples', '4'], exit: 1, text: /landed 2×/ },
  { name: 'file sink: a line appended twice is caught', cmd: ['node', ex('file-agent.mjs')], args: ['--intent', 'tool'], exit: 1, text: /FILE outbox.jsonl \[tool=refund_order\] landed 2×/ },
  { name: 'file sink: a stable key in the line passes', cmd: ['node', ex('file-agent.mjs')], args: ['--intent', 'tool'], env: { FILE_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  ...(hasSqlite
    ? [
        { name: 'database sink: a row inserted twice is caught', cmd: ['node', '--no-warnings', ex('db-agent.mjs')], exit: 1, text: /INSERT refunds landed 2×/ },
        { name: 'database sink: a unique key makes the second insert a no-op', cmd: ['node', '--no-warnings', ex('db-agent.mjs')], env: { DB_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
      ]
    : []),
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

let bad = 0
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
console.log(bad ? `${bad} failed` : `${cases.length} passed`)
process.exit(bad ? 1 : 0)
