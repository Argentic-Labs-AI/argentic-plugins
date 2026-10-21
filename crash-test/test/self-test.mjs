// Checks that crash-test's verdict depends on the agent: a plain loop must be caught, a keyed and checkpointed one must pass,
// the same keyed agent must fail when the receiver does not honour keys, and a broken restart must be reported as lost work.
// Run: node test/self-test.mjs
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'crash-test.mjs')
const cases = [
  { name: 'a checkpoint file with no key still duplicates the cut-off action', agent: 'checkpoint-agent.mjs', args: [], exit: 1, text: /cut off/ },
  { name: 'a frozen copy that wakes up late is caught (pause)', agent: 'plain-agent.mjs', args: ['--when', 'pause'], exit: 1, text: /frozen copy/ },
  { name: 'a keyed agent survives a frozen copy waking up late', agent: 'keyed-agent.mjs', args: ['--when', 'pause'], exit: 0, text: /duplicated effect: .*0/ },
  { name: 'SMTP: a mail sent twice is caught', agent: 'mail-agent.mjs', args: ['--intent', 'subject'], exit: 1, text: /SMTP to:dana@example.com/ },
  { name: 'SMTP: a stable key on the message passes', agent: 'mail-agent.mjs', args: ['--intent', 'subject'], env: { SMTP_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'payments API without an Idempotency-Key duplicates the refund', agent: 'payments-agent.mjs', args: [], exit: 1, text: /\/v1\/refunds landed 2×/ },
  { name: 'payments API with the key passes', agent: 'payments-agent.mjs', args: [], env: { PAY_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'a keyed agent that takes other routes passes and reports the divergence', agent: 'wandering-agent.mjs', args: ['--samples', '4'], env: { WANDER_KEYED: '1' }, exit: 0, text: /duplicated effect: .*0/ },
  { name: 'an unkeyed agent that takes other routes is still caught', agent: 'wandering-agent.mjs', args: ['--samples', '4'], exit: 1, text: /landed 2×/ },
  { name: 'plain loop is caught repeating finished actions', agent: 'plain-agent.mjs', args: [], exit: 1, text: /landed 2×/ },
  { name: 'keyed + checkpointed agent passes when the receiver dedupes on the key', agent: 'keyed-agent.mjs', args: [], exit: 0, text: /duplicated effect: .*0/ },
  { name: 'the same agent fails when the receiver ignores keys', agent: 'keyed-agent.mjs', args: ['--no-dedupe'], exit: 1, text: /landed 2×/ },
  { name: 'a restart that skips work is reported as lost', agent: 'lossy-agent.mjs', args: [], exit: 1, text: /never landed/ },
]
let bad = 0
for (const c of cases) {
  const r = spawnSync('node', [cli, '--no-promo', ...c.args, '--', 'node', join(root, 'examples', c.agent)], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...(c.env ?? {}) } })
  const ok = r.status === c.exit && c.text.test(r.stdout)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, wanted ${c.exit})`)
  if (!ok) {
    bad++
    console.log(r.stdout, r.stderr)
  }
}
process.exit(bad ? 1 : 0)
