// An agent that refunds an order through a Stripe-shaped API and keeps a progress file. PAY_KEYED=1 sends an Idempotency-Key with each charge,
// so the mock behaves like a payments API that honours it. Without it, a retry makes a second refund.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const stateDir = process.env.CRASHTEST_STATE_DIR
if (!sink || !stateDir) throw new Error('Run me under crash-test.')
const progress = join(stateDir, 'pay.json')
const done = new Set(existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])

const steps = [
  ['refund', '/v1/refunds', { payment_intent: 'pi_1182', amount: 4200 }],
  ['credit', '/v1/credit_notes', { invoice: 'in_1182', amount: 4200 }],
]
for (const [name, path, body] of steps) {
  if (done.has(name)) continue
  const res = await fetch(sink + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.PAY_KEYED ? { 'idempotency-key': `order-1182:${name}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  const j = await res.json()
  done.add(name)
  writeFileSync(progress, JSON.stringify([...done]))
  console.log(`${name}: ${j.id}`)
}
