// A stand-in for an LLM agent that does not take the same route twice: it picks one of two orders for the first two steps, and sometimes
// adds a note. By default it has no checkpoints and no keys. WANDER_KEYED=1 gives each action a stable key (its route plus the thing it
// acts on) and a progress file, the way a careful agent would. It shows how crash-test handles "path diverged".
// WANDER_SEQ_FILE makes the routes repeatable (crash-test's own tests use it): each run takes the next number from that file and seeds
// its choices with it. Without it the routes are random, which is the point of the example.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
if (!sink) throw new Error('Run me under crash-test.')
const keyed = Boolean(process.env.WANDER_KEYED)
const progress = join(process.env.CRASHTEST_STATE_DIR ?? '.', 'wander.json')
const done = new Set(keyed && existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])
const seqFile = process.env.WANDER_SEQ_FILE
const seq = seqFile ? (existsSync(seqFile) ? Number(readFileSync(seqFile, 'utf8')) : 0) : null
if (seqFile) writeFileSync(seqFile, String(seq + 1))
let seed = (seq ?? 0) * 2654435761 + 12345
const random = () => {
  if (seq === null) return Math.random()
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
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
if (random() < 0.5) first.reverse()
for (const [p, b] of first) await post(p, b)
if (random() < 0.4) await post('/add_note', { ticket_id: 'T-77', note: 'Customer is happy.' })
await post('/close_ticket', { ticket_id: 'T-77' })
console.log('done')
