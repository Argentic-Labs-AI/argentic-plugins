// An agent whose side effect is a line in an outbox file under $CRASHTEST_FILES_DIR (a spool, a ledger, a log someone else reads).
// FILE_KEYED=1 puts a stable key in each line and keeps a progress file in the state folder.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const files = process.env.CRASHTEST_FILES_DIR
const stateDir = process.env.CRASHTEST_STATE_DIR
if (!files || !stateDir) throw new Error('Run me under crash-test.')
const keyed = Boolean(process.env.FILE_KEYED)
const progress = join(stateDir, 'progress.json')
const done = new Set(keyed && existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : [])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const [step, line] of [
  ['refund', { tool: 'refund_order', order_id: '1182', amount_usd: 42 }],
  ['email', { tool: 'send_email', to: 'dana@example.com' }],
  ['close', { tool: 'close_ticket', ticket_id: 'T-77' }],
]) {
  if (done.has(step)) continue
  appendFileSync(join(files, 'outbox.jsonl'), JSON.stringify({ ...line, ...(keyed ? { key: `ticket-T-77:${step}` } : {}), at: new Date().toISOString() }) + '\n')
  await sleep(40)
  if (keyed) {
    done.add(step)
    writeFileSync(progress, JSON.stringify([...done]))
  }
}
console.log('done')
