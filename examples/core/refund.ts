// Refund demo with no framework: plain tools (a JSON schema and a handler) carry out the actions Argentic asks for.
// Run once with ARGENTIC_CRASH_AFTER=1 to die after the refund, then run again.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Argentic, freeModel, hintFor, runDurable, type DurableTool, type ModelSpec } from '../../adapters/typescript/argentic.ts'

export const system =
  'Tool calls are requests: their outcomes arrive in the next message. ' +
  'Call one tool per turn. When everything is done, reply with a one-line summary and no tool call.'

export const task =
  'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, ' +
  'email the customer that the refund is on its way, then close the ticket. Do one step at a time.'

/** Side effects land in a file so you can see nothing finished twice. */
export function makeTools(outbox: string): DurableTool[] {
  // Safe to repeat: the same idempotency key (agent:seq) is recorded once.
  const record = (key: string, name: string, data: object) => {
    const seen = existsSync(outbox) && readFileSync(outbox, 'utf8').split('\n').some((l) => l && JSON.parse(l).key === key)
    if (!seen) appendFileSync(outbox, JSON.stringify({ key, tool: name, ...data }) + '\n')
  }
  const str = { type: 'string' }
  return [
    {
      name: 'refund_order',
      description: 'Refund an order.',
      parameters: { type: 'object', properties: { order_id: str, amount_usd: { type: 'number' } }, required: ['order_id', 'amount_usd'] },
      execute: (args, { idempotencyKey }) => {
        record(idempotencyKey, 'refund_order', args)
        return { refunded: true, order_id: args.order_id, amount_usd: args.amount_usd }
      },
    },
    {
      name: 'send_email',
      description: 'Send an email to a customer.',
      parameters: { type: 'object', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
      execute: (args, { idempotencyKey }) => {
        record(idempotencyKey, 'send_email', args)
        return { sent: true, to: args.to }
      },
    },
    {
      name: 'close_ticket',
      description: 'Close a support ticket with a note.',
      parameters: { type: 'object', properties: { ticket_id: str, note: str }, required: ['ticket_id', 'note'] },
      execute: (args, { idempotencyKey }) => {
        record(idempotencyKey, 'close_ticket', args)
        return { closed: true, ticket_id: args.ticket_id }
      },
    },
  ]
}

export function outboxCounts(outbox: string): Record<string, number> {
  const counts: Record<string, number> = { refund_order: 0, send_email: 0, close_ticket: 0 }
  if (!existsSync(outbox)) return counts
  for (const line of readFileSync(outbox, 'utf8').split('\n')) {
    if (line) counts[JSON.parse(line).tool] = (counts[JSON.parse(line).tool] ?? 0) + 1
  }
  return counts
}

function modelFromEnv(): ModelSpec {
  const e = process.env
  if (!e.ARGENTIC_MODEL_ID) return freeModel
  return {
    provider: e.ARGENTIC_MODEL_PROVIDER ?? freeModel.provider,
    id: e.ARGENTIC_MODEL_ID,
    prices: { in: Number(e.ARGENTIC_PRICE_IN ?? 0), out: Number(e.ARGENTIC_PRICE_OUT ?? 0) },
  }
}

async function main() {
  const apiKey = process.env.ARGENTIC_API_KEY
  const modelKey = process.env.MODEL_KEY
  if (!apiKey || !modelKey) {
    console.error('Set ARGENTIC_API_KEY and MODEL_KEY first (see README).')
    process.exit(1)
  }
  const statePath = '.argentic-refund.json'
  const ledgerPath = '.argentic-ledger.json'
  const outbox = 'outbox.jsonl'

  if (process.argv.includes('--fresh')) for (const f of [statePath, ledgerPath, outbox]) rmSync(f, { force: true })
  if (!existsSync(statePath)) {
    const id = Math.random().toString(36).slice(2, 8)
    writeFileSync(statePath, JSON.stringify({ agent: `refund-demo-${id}`, runId: `run-${id}` }))
  }
  const { agent, runId } = JSON.parse(readFileSync(statePath, 'utf8')) as { agent: string; runId: string }
  console.log(`agent ${agent}, run ${runId}`)

  const client = new Argentic({ apiKey, modelKey })
  const crash = Number(process.env.ARGENTIC_CRASH_AFTER) || undefined
  const out = await runDurable({
    client,
    agent,
    runId,
    task,
    system,
    tools: makeTools(outbox),
    ledgerPath,
    model: modelFromEnv(),
    crashAfterActions: crash,
  })
  console.log(`\nreply: ${out.reply}`)
  console.log(`status ${out.status}, ${out.steps} steps, spent $${out.spentUsd}`)

  for (const wake of out.wakes) {
    const r = await client.replay(agent, wake)
    const verdict = r.mismatched === 0 && r.unverifiable === 0 ? 'all match' : `${r.mismatched} differ, ${r.unverifiable} not checkable`
    console.log(`replay ${wake}: ${r.turns.length} turn${r.turns.length === 1 ? "" : "s"}, ${verdict}`)
  }
  const dash = (process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')
  // the first wake is the run that was cut off: a rerun gets its stored answer back under the same id
  if (out.wakes[0]) console.log(`\nSee every step, then press Check prompts under Proof of what ran: ${dash}/platform/runs/${agent}/${out.wakes[0]}/`)
  console.log('\noutbox lines per tool (expect 1 each):')
  for (const [name, n] of Object.entries(outboxCounts(outbox))) console.log(`  ${name}: ${n}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e: unknown) => {
    const hint = hintFor(e)
    if (!hint) throw e
    console.error(`\n${e instanceof Error ? e.message : String(e)}\n${hint}`)
    process.exit(1)
  })
}
