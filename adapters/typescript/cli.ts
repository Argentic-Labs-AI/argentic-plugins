#!/usr/bin/env node
// `npx @argentic-labs/client demo`: kill an agent mid-run, run it again, and watch it skip what already finished.
// Uses only the published client. State lives in ./.argentic-demo/ so a rerun from the same folder picks up the same run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Argentic, freeModel, hintFor, runDurable, type DurableTool, type ModelSpec } from './argentic.ts'

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const yellow = paint('33')
const out = (s = '') => process.stdout.write(s + '\n')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const system =
  'Tool calls are requests: their outcomes arrive in the next message. ' +
  'Call one tool per turn. When everything is done, reply with a one-line summary and no tool call.'

const task =
  'Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, ' +
  'email the customer that the refund is on its way, then close the ticket. Do one step at a time.'

const usage = `Usage: npx @argentic-labs/client demo [--fresh] [--kill-after N]

  --fresh         start a new run (forget the one in ./.argentic-demo/)
  --kill-after N  kill the process yourself after N actions, instead of pressing Ctrl-C

Needs ARGENTIC_API_KEY (from https://getargentic.com/platform) and MODEL_KEY
(your model provider's key; the default model is a free NVIDIA one, key from https://build.nvidia.com).`

/** The side effects land in outbox.jsonl, keyed by the action's stable key, so a repeat is visible and harmless. */
function makeTools(outbox: string, workMs: number): DurableTool[] {
  const sent = (key: string) => existsSync(outbox) && readFileSync(outbox, 'utf8').split('\n').some((l) => l && JSON.parse(l).key === key)
  const act = async (key: string, seq: number, tool: string, what: string, data: object, result: object) => {
    process.stdout.write(`  ${bold('▸')} #${seq} ${tool.padEnd(14)} ${what} ${dim('…')}`)
    await sleep(workMs)
    if (sent(key)) {
      out(` ${yellow('already in the outbox under this key, not sent again')}`)
    } else {
      appendFileSync(outbox, JSON.stringify({ key, tool, ...data, at: new Date().toISOString() }) + '\n')
      out(` ${green('done')}`)
    }
    return result
  }
  const str = { type: 'string' }
  return [
    {
      name: 'refund_order',
      description: 'Refund an order.',
      parameters: { type: 'object', properties: { order_id: str, amount_usd: { type: 'number' } }, required: ['order_id', 'amount_usd'] },
      execute: (a, { idempotencyKey, seq }) =>
        act(idempotencyKey, seq, 'refund_order', `$${a.amount_usd} on order ${a.order_id}`, a, { refunded: true, order_id: a.order_id, amount_usd: a.amount_usd }),
    },
    {
      name: 'send_email',
      description: 'Send an email to a customer.',
      parameters: { type: 'object', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
      execute: (a, { idempotencyKey, seq }) => act(idempotencyKey, seq, 'send_email', `to ${a.to}`, a, { sent: true, to: a.to }),
    },
    {
      name: 'close_ticket',
      description: 'Close a support ticket with a note.',
      parameters: { type: 'object', properties: { ticket_id: str, note: str }, required: ['ticket_id', 'note'] },
      execute: (a, { idempotencyKey, seq }) => act(idempotencyKey, seq, 'close_ticket', `ticket ${a.ticket_id}`, a, { closed: true, ticket_id: a.ticket_id }),
    },
  ]
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

async function demo(argv: string[]) {
  const apiKey = process.env.ARGENTIC_API_KEY
  const modelKey = process.env.MODEL_KEY
  if (!apiKey || !modelKey) {
    console.error(`Set ARGENTIC_API_KEY and MODEL_KEY first.\n\n${usage}`)
    process.exit(1)
  }
  const at = argv.indexOf('--kill-after')
  const killAfter = at >= 0 ? Number(argv[at + 1]) || undefined : undefined
  const dir = '.argentic-demo'
  const statePath = join(dir, 'run.json')
  const ledgerPath = join(dir, 'ledger.json')
  const outbox = join(dir, 'outbox.jsonl')
  if (argv.includes('--fresh')) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const resuming = existsSync(statePath)
  if (!resuming) {
    const id = Math.random().toString(36).slice(2, 8)
    writeFileSync(statePath, JSON.stringify({ agent: `kill-demo-${id}`, runId: `run-${id}` }))
  }
  const { agent, runId } = JSON.parse(readFileSync(statePath, 'utf8')) as { agent: string; runId: string }
  const finishedBefore = existsSync(ledgerPath) ? Object.keys(JSON.parse(readFileSync(ledgerPath, 'utf8')).entries ?? {}).length : 0

  out(bold('Argentic: kill it mid-run'))
  out(dim(`agent ${agent}, run ${runId}, state in ./${dir}/`))
  out()
  if (!resuming) {
    out('A support agent works one ticket in three actions: refund the order, email the customer, close the ticket.')
    out(`Press ${bold('Ctrl-C')} while it works, then run the same command again.`)
  } else {
    out(`Picking up ${runId}: ${finishedBefore} action${finishedBefore === 1 ? '' : 's'} finished before it stopped.`)
    out('Same run, same keys. Finished actions are skipped, the rest carry on.')
  }
  out()

  process.on('SIGINT', () => {
    out('\n')
    out(yellow('Killed mid-run.') + ' Run the same command again and it picks up where it stopped.')
    process.exit(130)
  })

  const client = new Argentic({ apiKey, modelKey })
  let ran = 0
  let hinted = resuming || killAfter !== undefined
  const res = await runDurable({
    client,
    agent,
    runId,
    task,
    system,
    tools: makeTools(outbox, Number(process.env.ARGENTIC_DEMO_WORK_MS ?? 1500)),
    ledgerPath,
    model: modelFromEnv(),
    maxSteps: 10,
    crashAfterActions: killAfter,
    log: () => {},
    onWakeStart: ({ step }) => {
      if (step === 0 && !resuming) out(dim('  The first answer can take 15 seconds and nothing runs before it, so wait for the first action before pressing Ctrl-C.'))
      process.stdout.write(dim(`  model turn ${step + 1}: asking the model… `))
    },
    onWake: ({ replayed }) => {
      if (replayed) out(dim('answer already in the journal, sent back without calling the model again'))
      else out(dim('answered'))
    },
    onSkip: ({ tool, seq }) => out(`  ${dim('↷')} #${seq} ${tool.padEnd(14)} ${dim('finished on an earlier run, skipped')}`),
    onAction: ({ executed }) => {
      ran = executed
      if (killAfter && executed >= killAfter) out(yellow(`\nKilling the process now (--kill-after ${killAfter}). Run the same command without it.`))
      else if (!hinted) {
        hinted = true
        out(yellow('  Now is a good time to press Ctrl-C.'))
      }
    },
  })

  out()
  out(`${bold('Reply:')} ${res.reply || dim('(none)')}`)
  out(dim(`status ${res.status}, ${res.steps} model turns, ${ran} action${ran === 1 ? '' : 's'} run in this process, spent $${res.spentUsd.toFixed(4)}`))

  const counts: Record<string, number> = { refund_order: 0, send_email: 0, close_ticket: 0 }
  if (existsSync(outbox)) for (const l of readFileSync(outbox, 'utf8').split('\n')) if (l) counts[JSON.parse(l).tool] = (counts[JSON.parse(l).tool] ?? 0) + 1
  out()
  out(bold('What happened, from the outbox') + dim(` (./${outbox})`))
  for (const [tool, n] of Object.entries(counts)) out(`  ${tool.padEnd(14)} ${n === 1 ? green('1 time') : yellow(`${n} times`)}`)

  out()
  out(bold('Proof of what ran') + dim(' (re-renders each prompt from the journal and compares it with what the model was sent; free)'))
  let clean = true
  for (const wake of res.wakes) {
    const r = await client.replay(agent, wake)
    const ok = r.mismatched === 0 && r.unverifiable === 0
    clean &&= ok
    out(`  ${wake}  ${ok ? green('all match') : yellow(`${r.mismatched} differ, ${r.unverifiable} not checkable`)}`)
  }
  if (res.status !== 'done') out(yellow(`\nThe run stopped with status ${res.status}. Run the same command again to carry on.`))

  const dash = (process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')
  out()
  out(`See it in the dashboard: ${dash}/platform/ ${dim('->')} Runs ${dim('->')} ${agent}`)
  out(dim('Open the oldest run (the one you killed) and press Check prompts under Proof of what ran.'))
  out(dim('Start over with --fresh.'))
  if (!clean) process.exitCode = 1
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd !== 'demo') {
  out(usage)
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 1)
}
await demo(rest).catch((e: unknown) => {
  const hint = hintFor(e)
  if (!hint) throw e
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n${hint}`)
  process.exit(1)
})
