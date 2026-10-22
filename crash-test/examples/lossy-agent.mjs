// A broken restart: on a rerun it assumes the earlier run finished and does nothing, so whatever the kill cut off is lost.
// A control for crash-test's "lost" check.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const marker = join(process.env.CRASHTEST_STATE_DIR ?? '.', 'started')
if (!sink) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL.')
if (existsSync(marker)) {
  console.log('already ran, nothing to do')
  process.exit(0)
}
writeFileSync(marker, '1')
for (const path of ['/refund_order', '/send_email', '/close_ticket']) {
  await fetch(sink + path, { method: 'POST', body: '{}' })
}
