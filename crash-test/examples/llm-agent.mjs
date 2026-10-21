// A real tool-calling loop against an OpenAI-compatible chat API. Its model calls go through the pass-through crash-test makes for
// `--upstream model=<base url>` (CRASHTEST_UPSTREAM_MODEL_URL), so crash-test can kill it between a model reply and the tool call.
// Its tools post to the HTTP sink. LLM_KEYED=1 makes it careful: a stable key per action (tool plus the thing it acts on) and a
// progress file, so a restarted run does not send what already went out.
//   MODEL_KEY  your model provider's key      AGENT_MODEL_ID  the model id (default: a free NVIDIA model)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.CRASHTEST_SINK_URL
const stateDir = process.env.CRASHTEST_STATE_DIR
const base = (process.env.CRASHTEST_UPSTREAM_MODEL_URL ?? process.env.AGENT_MODEL_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '')
const model = process.env.AGENT_MODEL_ID ?? 'nvidia/nemotron-3.5-lightning-30b-a3b'
if (!sink || !stateDir) throw new Error('Run me under crash-test.')
const keyed = Boolean(process.env.LLM_KEYED)
const progress = join(stateDir, 'llm-progress.json')
const done = existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')) : {}

const str = { type: 'string' }
const tools = [
  { name: 'refund_order', description: 'Refund an order.', parameters: { type: 'object', properties: { order_id: str, amount_usd: { type: 'number' } }, required: ['order_id', 'amount_usd'] }, path: '/refund_order', on: (a) => a.order_id },
  { name: 'send_email', description: 'Send an email to a customer.', parameters: { type: 'object', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] }, path: '/send_email', on: (a) => a.to },
  { name: 'close_ticket', description: 'Close a support ticket with a note.', parameters: { type: 'object', properties: { ticket_id: str, note: str }, required: ['ticket_id', 'note'] }, path: '/close_ticket', on: (a) => a.ticket_id },
]

async function run(tool, args) {
  const key = `${tool.name}:${tool.on(args)}`
  if (keyed && done[key]) return done[key]
  const res = await fetch(sink + tool.path, { method: 'POST', headers: { 'content-type': 'application/json', ...(keyed ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(args) })
  if (!res.ok) throw new Error(`${tool.path} -> ${res.status}`)
  const result = { ok: true, tool: tool.name }
  if (keyed) {
    done[key] = result
    writeFileSync(progress, JSON.stringify(done))
  }
  return result
}

const messages = [
  { role: 'system', content: 'You are a support agent. Call one tool per turn. When everything is done, reply with a one-line summary and no tool call.' },
  { role: 'user', content: 'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, email the customer that the refund is on its way, then close the ticket. Do one step at a time.' },
]
for (let turn = 0; turn < 8; turn++) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MODEL_KEY ?? 'none'}` },
    body: JSON.stringify({ model, messages, max_tokens: 1200, tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
  })
  if (!res.ok) throw new Error(`model -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  const msg = (await res.json()).choices[0].message
  const calls = msg.tool_calls ?? []
  messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) })
  if (!calls.length) {
    console.log(`done: ${(msg.content ?? '').slice(0, 120)}`)
    process.exit(0)
  }
  for (const c of calls) {
    const tool = tools.find((t) => t.name === c.function.name)
    const out = tool ? await run(tool, JSON.parse(c.function.arguments || '{}')) : { error: 'unknown tool' }
    messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) })
  }
}
throw new Error('the model did not finish in 8 turns')
