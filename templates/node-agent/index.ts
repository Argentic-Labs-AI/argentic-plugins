// A support agent that sends one email. Press Ctrl-C while it works, run it again, and it does not send twice.
// Argentic runs the loop and keeps the journal; the tools are ordinary Vercel AI SDK tool() objects.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Argentic, hintFor, runDurable } from '@argentic-labs/client'
import { fromAiSdkTools } from '@argentic-labs/client/ai-sdk'
import { tool } from 'ai'
import { z } from 'zod'

const apiKey = process.env.ARGENTIC_API_KEY
const modelKey = process.env.MODEL_KEY
if (!apiKey || !modelKey) {
  console.error('Set ARGENTIC_API_KEY and MODEL_KEY first (see .env.example).')
  process.exit(1)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const killAt = process.argv.indexOf('--kill-after')
const killAfter = killAt >= 0 ? Number(process.argv[killAt + 1]) || undefined : undefined

// State lives in ./.agent so a second run from this folder picks up the first one.
const dir = '.agent'
const outbox = `${dir}/outbox.jsonl`
if (process.argv.includes('--fresh')) rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
if (!existsSync(`${dir}/run.json`)) {
  const id = Math.random().toString(36).slice(2, 8)
  writeFileSync(`${dir}/run.json`, JSON.stringify({ agent: `support-${id}`, runId: `run-${id}` }))
}
const { agent, runId } = JSON.parse(readFileSync(`${dir}/run.json`, 'utf8')) as { agent: string; runId: string }

const sent = (key: string) => existsSync(outbox) && readFileSync(outbox, 'utf8').split('\n').some((l) => l && JSON.parse(l).key === key)

const tools = {
  lookup_order: tool({
    description: 'Look up an order by its number.',
    inputSchema: z.object({ order_id: z.string() }),
    execute: async ({ order_id }) => {
      await sleep(1500)
      return { order_id, customer: 'Dana Whitfield', email: 'dana@example.com', item: 'Ceramic pour-over set', status: 'delivered, reported broken' }
    },
  }),
  send_email: tool({
    description: 'Send one email to a customer.',
    // Shortest property name first: Argentic stores tools as jsonb, which sorts keys that way.
    inputSchema: z.object({ to: z.string(), body: z.string(), subject: z.string() }),
    // toolCallId is the action's stable key, `${agent}:${seq}`, the same on every retry.
    execute: async (mail, { toolCallId }) => {
      const repeat = sent(toolCallId)
      if (!repeat) appendFileSync(outbox, JSON.stringify({ key: toolCallId, ...mail }) + '\n') // the "provider" took it
      await sleep(2500) // the provider's answer is slow: Ctrl-C here and the mail has already left
      console.log(repeat ? `  send_email ${toolCallId}: the provider already had this key, not sent again` : `  send_email ${toolCallId}: sent to ${mail.to}`)
      return { sent: true, to: mail.to }
    },
  }),
}

const client = new Argentic({ apiKey, modelKey })
console.log(`agent ${agent}, run ${runId}. Press Ctrl-C while it works, then run it again.\n`)
process.on('SIGINT', () => {
  console.log('\nKilled. Run the same command again and it picks up where it stopped.')
  process.exit(130)
})

try {
  const out = await runDurable({
    client,
    agent,
    runId,
    task:
      'New ticket from dana@example.com: "Order 1182 arrived broken." Look up the order, then email the customer: ' +
      'apologise and say a replacement ships today, in under 80 words.',
    system:
      'You are a customer support agent. Tool calls are requests: their outcomes arrive in the next message. ' +
      'Call one tool per turn. Send exactly one email, and only after looking up the order. ' +
      'When it is sent, reply with a one-line summary and no tool call.',
    tools: await fromAiSdkTools(tools),
    ledgerPath: `${dir}/ledger.json`,
    crashAfterActions: killAfter,
    log: (line) => console.log(line),
  })
  console.log(`\nreply: ${out.reply}`)

  const count = existsSync(outbox) ? readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0
  console.log(`emails in ${outbox}: ${count}`)
  for (const wake of out.wakes) {
    const r = await client.replay(agent, wake)
    console.log(`proof ${wake}: ${r.mismatched === 0 && r.unverifiable === 0 ? 'all match' : `${r.mismatched} differ`}`)
  }
  console.log(`\nSee the run: ${(process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')}/platform/runs/${agent}/${out.wakes[0]}`)
} catch (e) {
  const hint = hintFor(e)
  if (!hint) throw e
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n${hint}`)
  process.exit(1)
}
