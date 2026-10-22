// A stand-in for an LLM agent that does not take the same route twice: it picks one of two orders for the first two steps, and sometimes
// adds a note. By default it has no checkpoints and no keys. WANDER_KEYED=1 gives each action a stable key (its route plus the thing it
// acts on) and a progress file, the way a careful agent would. It shows how crash-test handles "path diverged".
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
if (!sink) throw new Error('Run me under crash-test.')
const keyed = Boolean(process.env.WANDER_KEYED)
const progress = join(process.env.CRASHTEST_STATE_DIR ?? '.', 'wander.json')
const done = new Set(keyed && existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])
const post = async (path, body) => {
  const id = `${path}:${body.order_id ?? body.ticket_id ?? body.to}`
  if (done.has(id)) return
  await fetch(sink + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(keyed ? { 'idempotency-key': id } : {}) }, body: JSON.stringify(body) })
  if (keyed) {
    done.add(id)
    writeFileSync(progress, JSON.stringify([...done]))
  }
}

const first = [['/refund_order', { order_id: '1182', amount_usd: 42 }], ['/send_email', { to: 'dana@example.com', subject: 'Your refund' }]]
if (Math.random() < 0.5) first.reverse()
for (const [p, b] of first) await post(p, b)
if (Math.random() < 0.4) await post('/add_note', { ticket_id: 'T-77', note: 'Customer is happy.' })
await post('/close_ticket', { ticket_id: 'T-77' })
console.log('done')
