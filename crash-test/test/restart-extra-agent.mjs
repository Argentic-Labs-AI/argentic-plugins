// Posts two actions. After a restart (the state folder already has a marker) it also posts a third that no clean run makes.
// crash-test must report that as a different route, not as a repeat: the extra action landed once.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const marker = join(process.env.CRASHTEST_STATE_DIR, 'started')
const restarted = existsSync(marker)
writeFileSync(marker, '1')
const post = (path, body) => fetch(sink + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': path }, body: JSON.stringify(body) })
await post('/a', { n: 1 })
await post('/b', { n: 2 })
if (restarted) await post('/c', { n: 3 })
console.log('done')
