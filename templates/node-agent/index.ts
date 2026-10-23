// A support agent that sends one email. Press Ctrl-C while it works, run it again, and it does not send twice.
// The loop is your own Vercel AI SDK generateText. Argentic journals each model step and tool call, and serves the
// recorded ones back when the same run starts again. If your Argentic account does not have "keep your loop" yet,
// this falls back to the older mode where Argentic runs the loop (or force it with --loop argentic).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Argentic, ArgenticError, freeModel, hintFor, runDurable } from '@argentic-labs/client'
import { durableRun, fromAiSdkTools } from '@argentic-labs/client/ai-sdk'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const apiKey = process.env.ARGENTIC_API_KEY
const modelKey = process.env.MODEL_KEY
if (!apiKey || !modelKey) {
  console.error('Set ARGENTIC_API_KEY and MODEL_KEY first (see .env.example).')
  process.exit(1)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const flag = (name: string) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const killAfter = Number(flag('--kill-after')) || undefined

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

const task =
  'New ticket from dana@example.com: "Order 1182 arrived broken." Look up the order, then email the customer: ' +
  'apologise and say a replacement ships today, in under 80 words.'
const system = 'You are a customer support agent. Send exactly one email, and only after looking up the order. When it is sent, reply with a one-line summary.'

/** The tools are ordinary AI SDK tool() objects. `keyOf` turns a toolCallId into the action's stable key. */
function makeTools(keyOf: (toolCallId: string) => string, afterAction = () => {}) {
  return {
    lookup_order: tool({
      description: 'Look up an order by its number.',
      inputSchema: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => {
        await sleep(1500)
        afterAction()
        return { order_id, customer: 'Dana Whitfield', email: 'dana@example.com', item: 'Ceramic pour-over set', status: 'delivered, reported broken' }
      },
    }),
    send_email: tool({
      description: 'Send one email to a customer.',
      // Keep this property order: the older mode compares the tool list from one wake to the next.
      inputSchema: z.object({ to: z.string(), body: z.string(), subject: z.string() }),
      execute: async (mail, { toolCallId }) => {
        const key = keyOf(toolCallId) // the same on every retry
        const repeat = sent(key)
        if (!repeat) appendFileSync(outbox, JSON.stringify({ key, ...mail }) + '\n') // the "provider" took it
        await sleep(2500) // the provider's answer is slow: Ctrl-C here and the mail has already left
        console.log(repeat ? `  send_email ${key}: the provider already had this key, not sent again` : `  send_email ${key}: sent to ${mail.to}`)
        afterAction() // with --kill-after, the process dies here: the mail left, the result was never recorded
        return { sent: true, to: mail.to }
      },
    }),
  }
}

const client = new Argentic({ apiKey, modelKey })
console.log(`agent ${agent}, run ${runId}. Press Ctrl-C while it works, then run it again.\n`)
process.on('SIGINT', () => {
  console.log('\nKilled. Run the same command again and it picks up where it stopped.')
  process.exit(130)
})

/** Your loop. Returns undefined if this account does not have keep your loop (the server answers 404 to opening a run). */
async function keepYourLoop(): Promise<string | undefined> {
  let run
  try {
    run = await durableRun(client, { agent, runId })
  } catch (e) {
    if (e instanceof ArgenticError && e.status === 404) return undefined
    throw e
  }
  let done = 0
  const afterAction = () => {
    if (++done === killAfter) process.exit(130)
  }
  // Any OpenAI-compatible provider works here. The default is the free NVIDIA model.
  const model = createOpenAICompatible({
    name: 'model',
    baseURL: process.env.MODEL_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    apiKey: modelKey,
  }).chatModel(process.env.MODEL_ID ?? freeModel.id)
  const result = await generateText({
    model: run.model(model),
    // lookup_order only reads, and send_email passes its key to the provider, so either may run again if cut off mid-call.
    tools: run.tools(makeTools(run.keyFor.bind(run), afterAction), { dedupesOnKey: ['lookup_order', 'send_email'] }),
    stopWhen: stepCountIs(8),
    system,
    prompt: task,
  })
  await run.finish({ reply: result.text })
  return result.text
}

/** The older mode: Argentic runs the loop, your code carries out the tools it asks for. */
async function argenticLoop(): Promise<string> {
  const out = await runDurable({
    client,
    agent,
    runId,
    task,
    system: system + ' Tool calls are requests: their outcomes arrive in the next message. Call one tool per turn.',
    tools: await fromAiSdkTools(makeTools((toolCallId) => toolCallId)),
    ledgerPath: `${dir}/ledger.json`,
    crashAfterActions: killAfter,
    log: (line) => console.log(line),
  })
  for (const wake of out.wakes) {
    const r = await client.replay(agent, wake)
    console.log(`proof ${wake}: ${r.mismatched === 0 && r.unverifiable === 0 ? 'all match' : `${r.mismatched} differ`}`)
  }
  console.log(`\nSee the run: ${(process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')}/platform/runs/${agent}/${out.wakes[0]}`)
  return out.reply
}

try {
  let reply = flag('--loop') === 'argentic' ? undefined : await keepYourLoop()
  if (reply === undefined) {
    if (flag('--loop') !== 'argentic') console.log('Keep your loop is not turned on for this account, so Argentic runs the loop instead.\n')
    reply = await argenticLoop()
  }
  console.log(`\nreply: ${reply}`)
  const count = existsSync(outbox) ? readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0
  console.log(`emails in ${outbox}: ${count}`)
} catch (e) {
  const hint = hintFor(e)
  if (!hint) throw e
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n${hint}`)
  process.exit(1)
}
