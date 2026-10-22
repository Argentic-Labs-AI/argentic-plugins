# Argentic for TypeScript

Argentic runs the agent loop. Your Vercel AI SDK or Mastra tools and system prompt carry over; the framework's own loop (`generateText`, `Agent`, Mastra `Agent.generate`) is not used.

Each tool call the agent makes comes back to your code to carry out. If the process dies mid-run, run it again: it resumes without repeating a finished action, and the run keeps proof of what ran.

## Try it

```
npx @argentic-labs/client demo
```

Set `ARGENTIC_API_KEY` and `MODEL_KEY` first. Press Ctrl-C while it works, run it again, and it skips what already finished. Details in the [repo README](../../README.md#kill-it-mid-run-2-minutes).

## Install

```
npm i @argentic-labs/client
```

- `@argentic-labs/client`: the client and `runDurable`, no dependencies, Node 22+.
- `@argentic-labs/client/ai-sdk`: `fromAiSdkTools` and `durableRun`, need `ai` v6 or v7.
- `@argentic-labs/client/mastra`: `fromMastraTools`, takes the `createTool()` tools you would pass to an Agent (the key is the tool name). Needs `@mastra/core` 1.x for the tools; the adapter itself imports nothing.

To vendor it instead: clone this repo and copy `argentic.ts`, `ai-sdk.ts` and `mastra.ts` into your project (Node 22+, no package needed beyond what you already use).

## Use

```ts
import { tool } from 'ai'
import { z } from 'zod'
import { Argentic, runDurable } from '@argentic-labs/client'
import { fromAiSdkTools } from '@argentic-labs/client/ai-sdk'

const tools = { refund_order: tool({
  description: 'Refund an order.',
  inputSchema: z.object({ order_id: z.string(), amount_usd: z.number() }),
  execute: async (args, { toolCallId }) => refund(args, toolCallId),
}) }

// apiKey defaults to ARGENTIC_API_KEY
const client = new Argentic({ modelKey: process.env.MODEL_KEY })
const out = await runDurable({
  client, agent: 'my-agent', runId: 'order-1182', ledgerPath: '.argentic-ledger.json',
  task: 'Refund order 1182.', system: 'Call one tool per turn.',
  tools: await fromAiSdkTools(tools),
})
console.log(out.reply)
```

Keep `agent` and `runId` the same across restarts. `client.replay(agent, wakeId)` re-renders a wake's prompts from the journal and compares them to what the model saw; it calls no model and spends nothing.

## Keep your loop (`durableRun`)

If you already have a working `generateText`, `streamText` or `ToolLoopAgent`, keep it. Argentic never calls your model and never builds your prompt: a wrapped model and wrapped tools write each step to the agent's journal before its effects can happen, and serve recorded steps back when the same run restarts.

```ts
import { stepCountIs, generateText } from 'ai'
import { Argentic } from '@argentic-labs/client'
import { durableRun } from '@argentic-labs/client/ai-sdk'

const client = new Argentic()
const run = await durableRun(client, { agent: 'refunds', runId: order.id })
const result = await generateText({
  model: run.model(openai('gpt-5.1')),
  tools: run.tools({ refund, email }, { dedupesOnKey: ['refund'] }),
  stopWhen: stepCountIs(10),
  prompt,
})
await run.finish({ reply: result.text })
```

Run the same code with the same `runId` after a crash. `durableRun` opens the run (one POST) and holds its events in memory, so replaying a finished prefix costs no round trips.

- Model steps: a recorded step with the same request returns the recorded reply with no provider call (`streamText` plays it back as a stream). A recorded step with a different request throws `ArgenticDivergence` and writes nothing: your code, or something it read, changed between runs. A step with no record is called live and is acknowledged by Argentic before the SDK sees its tool calls. `streamText` text deltas pass through live; tool-call parts are held until the step is recorded.
- Tools: a finished tool returns its recorded result (or rethrows its recorded error) without running. A tool that started and never finished runs again only if you list it in `dedupesOnKey` (it must pass `run.keyFor(toolCallId)` to something that refuses a repeat, such as a Stripe `Idempotency-Key`). Otherwise `onUnknown: 'stop'` (default) throws `ArgenticUnknownOutcome`; check your own records, then `await run.resolve(key, result)`. `onUnknown: 'tell_model'` returns `{ status: 'unknown' }` to the model instead.
- Keys: `run.keyFor(toolCallId)` is `<agent>:<run>:m<n>.t<i>`, assigned by position, never by the model or the arguments. A failed provider attempt that `maxRetries` retries takes no position.
- Tool results go back to the SDK as their JSON form on the live run too (a `Date` becomes its ISO string), so a restart sees the same prompt. A result that cannot be serialized fails the call.
- `run.step(name, fn)` runs a non-deterministic read (a clock, a random number, a lookup that feeds the prompt) once and records it.
- Another process opening the same run fences this one (`ArgenticFenced`): nothing more runs here. A crossed spend cap (`limits: { max_usd }` plus `prices`) records the step and throws `ArgenticSpendCap` before its tools run.
- Writes that are not acknowledged are retried with the same body until `writeDeadlineMs` (default 60 s), then the wrapper throws without running the tool. Argentic's availability is a dependency of your run.

Limits in this release: one run is one sequential chain of model calls (no `run.child()` yet, so two model calls at once on one run will report a divergence); only tools passed through `run.tools()` and models through `run.model()` are covered; prompts, memory and cost stay as your framework builds them. This is recovery and proof, not exactly-once: a side effect outside a wrapped tool, or a tool that ignores its key, can still repeat. Needs a server with `EXTERNAL_LOOPS` on.

What is sent to Argentic: your model key never is, since your app calls the provider itself. Everything needed to replay a run is: the messages each model step adds, the model's full response, token usage, each tool's arguments hash and its full result (or error), `run.step` results and the final reply. These are stored in the agent's journal on Argentic and appear in its proof bundle. Keep secrets and personal data you don't want stored out of tool results and prompts, or redact them before the tool returns.

## What to know

Delivery is at-least-once. An action that was running when the process died, before its result reached the local ledger, runs again on resume. Make your handlers safe to repeat: the AI SDK `toolCallId` your `execute` receives is a stable key (`agent:seq`) to dedupe on.

Mastra tools get the same key as `context.agent.toolCallId`.

Full walkthroughs: [`examples/ai-sdk`](../../examples/ai-sdk), [`examples/mastra`](../../examples/mastra).
