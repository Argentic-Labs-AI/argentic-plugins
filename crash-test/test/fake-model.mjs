// A scripted OpenAI-compatible chat endpoint for the self-test: refund, email, close, then a one-line reply.
import http from 'node:http'

const script = [
  { name: 'refund_order', args: { order_id: '1182', amount_usd: 42 } },
  { name: 'send_email', args: { to: 'dana@example.com', subject: 'Your refund', body: 'On its way.' } },
  { name: 'close_ticket', args: { ticket_id: 'T-77', note: 'Refunded and emailed.' } },
]

export function startFakeModel() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const messages = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages ?? []
      const step = script[messages.filter((m) => m.role === 'tool').length]
      const message = step
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${messages.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: 'Refunded $42, emailed Dana and closed T-77.' }
      const body = JSON.stringify({ id: 'x', object: 'chat.completion', model: 'fake', choices: [{ index: 0, finish_reason: step ? 'tool_calls' : 'stop', message }] })
      res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() })))
}
