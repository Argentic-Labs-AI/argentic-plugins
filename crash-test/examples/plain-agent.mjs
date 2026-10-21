// A plain agent loop, no framework and no checkpoints: it works a ticket in three steps and starts from the top every time it runs.
// The "model" is a fixed plan so the demo is repeatable; swap in any LLM call and the result is the same.
const sink = process.env.CRASHTEST_SINK_URL
if (!sink) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL.')

const call = async (path, body) => {
  const res = await fetch(sink + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const plan = [
  ['/refund_order', { order_id: '1182', amount_usd: 42 }],
  ['/send_email', { to: 'dana@example.com', subject: 'Your refund', body: 'Your refund is on its way.' }],
  ['/close_ticket', { ticket_id: 'T-77', note: 'Refunded and emailed.' }],
]
for (const [path, body] of plan) {
  await call(path, body)
  console.log(`did ${path}`)
}
console.log('done')
