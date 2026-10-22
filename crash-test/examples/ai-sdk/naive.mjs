// A support agent on the Vercel AI SDK, written the way the docs show it. Each tool does its work and returns.
// Nothing remembers what already went out, so a restarted agent starts at the top and does it all again.
// Run it under crash-test:   node ../../crash-test.mjs -- node naive.mjs
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { scriptedModel } from './model.mjs'

const sink = process.env.CRASHTEST_SINK_URL
if (!sink) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL.')

// Your real tools would call Stripe, your mail provider, your ticket system. Here they call the local stand-in.
const post = async (path, body) => {
  const res = await fetch(sink + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const tools = {
  refund_order: tool({
    description: 'Refund an order.',
    inputSchema: z.object({ order_id: z.string(), amount_usd: z.number() }),
    execute: (args) => post('/refund_order', args),
  }),
  send_email: tool({
    description: 'Send an email to a customer.',
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    execute: (args) => post('/send_email', args),
  }),
  close_ticket: tool({
    description: 'Close a support ticket with a note.',
    inputSchema: z.object({ ticket_id: z.string(), note: z.string() }),
    execute: (args) => post('/close_ticket', args),
  }),
}

const { text } = await generateText({
  model: scriptedModel(),
  tools,
  stopWhen: stepCountIs(8),
  prompt: 'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, email the customer, then close the ticket.',
})
console.log(text)
