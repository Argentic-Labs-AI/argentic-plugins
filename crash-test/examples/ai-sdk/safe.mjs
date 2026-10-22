// The same agent, made safe to restart. The only change: each tool sends an Idempotency-Key built from the thing it acts on
// (the order, the ticket, the recipient and subject). A restarted agent asks for the same action with the same key, and a receiver
// that honours keys, as payment APIs do, treats it as the one it already did.
// Run it under crash-test:   node ../../crash-test.mjs -- node safe.mjs
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { scriptedModel } from './model.mjs'

const sink = process.env.CRASHTEST_SINK_URL
if (!sink) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL.')

const post = async (path, key, body) => {
  const res = await fetch(sink + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, // <- the fix
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const tools = {
  refund_order: tool({
    description: 'Refund an order.',
    inputSchema: z.object({ order_id: z.string(), amount_usd: z.number() }),
    execute: (args) => post('/refund_order', `refund:${args.order_id}`, args),
  }),
  send_email: tool({
    description: 'Send an email to a customer.',
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    execute: (args) => post('/send_email', `email:${args.to}:${args.subject}`, args),
  }),
  close_ticket: tool({
    description: 'Close a support ticket with a note.',
    inputSchema: z.object({ ticket_id: z.string(), note: z.string() }),
    execute: (args) => post('/close_ticket', `close:${args.ticket_id}`, args),
  }),
}

const { text } = await generateText({
  model: scriptedModel(),
  tools,
  stopWhen: stepCountIs(8),
  prompt: 'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, email the customer, then close the ticket.',
})
console.log(text)
