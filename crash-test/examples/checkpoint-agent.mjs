// A common hand-rolled fix: write progress to a file after each action. It cannot close the gap between the action landing and the
// file write, and it sends no key, so a retry of the cut-off action lands twice.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const stateDir = process.env.CRASHTEST_STATE_DIR
if (!sink || !stateDir) throw new Error('Run me under crash-test.')
const progress = join(stateDir, 'progress.json')
const done = new Set(existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])
for (const [step, path, body] of [
  ['refund', '/refund_order', { order_id: '1182', amount_usd: 42 }],
  ['email', '/send_email', { to: 'dana@example.com', subject: 'Your refund', body: 'On its way.' }],
  ['close', '/close_ticket', { ticket_id: 'T-77', note: 'Refunded and emailed.' }],
]) {
  if (done.has(step)) continue
  const res = await fetch(sink + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  done.add(step)
  writeFileSync(progress, JSON.stringify([...done]))
}
