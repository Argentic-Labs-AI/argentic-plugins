// Checks that crash-test's verdict depends on the agent: a plain loop must be caught, a keyed and checkpointed one must pass,
// the same keyed agent must fail when the receiver does not honour keys, and a broken restart must be reported as lost work.
// Run: node test/self-test.mjs
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'crash-test.mjs')
const cases = [
  { name: 'plain loop is caught repeating finished actions', agent: 'plain-agent.mjs', args: [], exit: 1, text: /landed 2×/ },
  { name: 'keyed + checkpointed agent passes when the receiver dedupes on the key', agent: 'keyed-agent.mjs', args: [], exit: 0, text: /duplicated effect: .*0/ },
  { name: 'the same agent fails when the receiver ignores keys', agent: 'keyed-agent.mjs', args: ['--no-dedupe'], exit: 1, text: /landed 2×/ },
  { name: 'a restart that skips work is reported as lost', agent: 'lossy-agent.mjs', args: [], exit: 1, text: /never landed/ },
]
let bad = 0
for (const c of cases) {
  const r = spawnSync('node', [cli, '--no-promo', ...c.args, '--', 'node', join(root, 'examples', c.agent)], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  const ok = r.status === c.exit && c.text.test(r.stdout)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, wanted ${c.exit})`)
  if (!ok) {
    bad++
    console.log(r.stdout, r.stderr)
  }
}
process.exit(bad ? 1 : 0)
