// An agent whose side effect is a row in a SQLite table at $CRASHTEST_DB_PATH. DB_KEYED=1 gives each row a unique key and inserts with
// "or ignore", so the database itself refuses the second copy. Run with node --no-warnings (node:sqlite is still marked experimental).
import { DatabaseSync } from 'node:sqlite'

const path = process.env.CRASHTEST_DB_PATH
if (!path) throw new Error('Run me under crash-test.')
const keyed = Boolean(process.env.DB_KEYED)
const db = new DatabaseSync(path)
db.exec(`create table if not exists refunds (idempotency_key text ${keyed ? 'unique' : ''}, order_id text, amount_usd real)`)
db.exec(`create table if not exists emails (idempotency_key text ${keyed ? 'unique' : ''}, recipient text)`)
db.exec(`create table if not exists tickets_closed (idempotency_key text ${keyed ? 'unique' : ''}, ticket_id text)`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const verb = keyed ? 'insert or ignore' : 'insert'

db.prepare(`${verb} into refunds values (?, ?, ?)`).run(keyed ? 'ticket-T-77:refund' : null, '1182', 42)
await sleep(40)
db.prepare(`${verb} into emails values (?, ?)`).run(keyed ? 'ticket-T-77:email' : null, 'dana@example.com')
await sleep(40)
db.prepare(`${verb} into tickets_closed values (?, ?)`).run(keyed ? 'ticket-T-77:close' : null, 'T-77')
console.log('done')
