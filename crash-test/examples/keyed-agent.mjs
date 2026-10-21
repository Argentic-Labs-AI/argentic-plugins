// The same ticket, written to survive a restart: it sends a stable Idempotency-Key with every action and writes its progress to a
// file after each reply. This is the control for crash-test: it should come out clean, and it does only when the receiver honours the key.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const stateDir = process.env.CRASHTEST_STATE_DIR
if (!sink || !stateDir) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL and CRASHTEST_STATE_DIR.')
const progress = join(stateDir, 'progress.json')
const finished = new Set(existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])

const plan = [
  ['refund', '/refund_order', { order_id: '1182', amount_usd: 42 }],
  ['email', '/send_email', { to: 'dana@example.com', subject: 'Your refund', body: 'Your refund is on its way.' }],
  ['close', '/close_ticket', { ticket_id: 'T-77', note: 'Refunded and emailed.' }],
]
for (const [step, path, body] of plan) {
  if (finished.has(step)) continue
  const res = await fetch(sink + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `ticket-T-77:${step}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  finished.add(step)
  writeFileSync(progress, JSON.stringify([...finished]))
  console.log(`did ${path}`)
}
console.log('done')
