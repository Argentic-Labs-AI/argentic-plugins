// The quickstart support agent, run under crash-test. Same three actions as plain-agent.mjs, but the loop runs on Argentic and each
// action goes to the sink with the key Argentic hands it. crash-test does not know that: it only sees what arrives at the sink.
//   ARGENTIC_API_KEY  an Argentic API key        MODEL_KEY  your model provider's key      ARGENTIC_BASE_URL  the API (default: production)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Argentic, freeModel, runDurable, type DurableTool, type ModelSpec } from '../../adapters/typescript/argentic.ts'

const sink = process.env.CRASHTEST_SINK_URL
const stateDir = process.env.CRASHTEST_STATE_DIR
const apiKey = process.env.ARGENTIC_API_KEY
const modelKey = process.env.MODEL_KEY
if (!sink || !stateDir) throw new Error('Run me under crash-test: it sets CRASHTEST_SINK_URL and CRASHTEST_STATE_DIR.')
if (!apiKey || !modelKey) throw new Error('Set ARGENTIC_API_KEY and MODEL_KEY first.')

const system =
  'Tool calls are requests: their outcomes arrive in the next message. ' +
  'Call one tool per turn. When everything is done, reply with a one-line summary and no tool call.'
const task =
  'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, ' +
  'email the customer that the refund is on its way, then close the ticket. Do one step at a time.'

const send = async (path: string, key: string, body: object) => {
  const res = await fetch(sink + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
}

const str = { type: 'string' }
const tools: DurableTool[] = [
  {
    name: 'refund_order',
    description: 'Refund an order.',
    parameters: { type: 'object', properties: { order_id: str, amount_usd: { type: 'number' } }, required: ['order_id', 'amount_usd'] },
    execute: async (a, { idempotencyKey }) => {
      await send('/refund_order', idempotencyKey, a)
      return { refunded: true, order_id: a.order_id, amount_usd: a.amount_usd }
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to a customer.',
    parameters: { type: 'object', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
    execute: async (a, { idempotencyKey }) => {
      await send('/send_email', idempotencyKey, a)
      return { sent: true, to: a.to }
    },
  },
  {
    name: 'close_ticket',
    description: 'Close a support ticket with a note.',
    parameters: { type: 'object', properties: { ticket_id: str, note: str }, required: ['ticket_id', 'note'] },
    execute: async (a, { idempotencyKey }) => {
      await send('/close_ticket', idempotencyKey, a)
      return { closed: true, ticket_id: a.ticket_id }
    },
  },
]

// A rerun in the same state folder continues the same run; a fresh folder starts a new one.
const statePath = join(stateDir, 'run.json')
if (!existsSync(statePath)) {
  const id = Math.random().toString(36).slice(2, 8)
  writeFileSync(statePath, JSON.stringify({ agent: `crash-test-${id}`, runId: `run-${id}` }))
}
const { agent, runId } = JSON.parse(readFileSync(statePath, 'utf8')) as { agent: string; runId: string }

const e = process.env
const model: ModelSpec = e.ARGENTIC_MODEL_ID
  ? { provider: e.ARGENTIC_MODEL_PROVIDER ?? freeModel.provider, id: e.ARGENTIC_MODEL_ID, prices: { in: Number(e.ARGENTIC_PRICE_IN ?? 0), out: Number(e.ARGENTIC_PRICE_OUT ?? 0) } }
  : freeModel

const out = await runDurable({
  client: new Argentic({ apiKey, modelKey }),
  agent,
  runId,
  task,
  system,
  tools,
  ledgerPath: join(stateDir, 'ledger.json'),
  model,
})
console.log(`status ${out.status}, ${out.steps} steps: ${out.reply}`)
