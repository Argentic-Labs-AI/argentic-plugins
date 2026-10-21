# Argentic for TypeScript

Argentic runs the agent loop. Your Vercel AI SDK or Mastra tools and system prompt carry over; the framework's own loop (`generateText`, `Agent`, Mastra `Agent.generate`) is not used.

Each tool call the agent makes comes back to your code to carry out. If the process dies mid-run, run it again: it resumes without repeating a finished action, and the run keeps proof of what ran.

## Install

Once published (not yet; until then use the copy path below):

```
npm i @argentic-labs/client
```

- `@argentic-labs/client`: the client and `runDurable`, no dependencies, Node 22+.
- `@argentic-labs/client/ai-sdk`: `fromAiSdkTools`, needs `ai` v5 or v6.
- `@argentic-labs/client/mastra`: `fromMastraTools`, takes the `createTool()` tools you would pass to an Agent (the key is the tool name). Needs `@mastra/core` 1.x for the tools; the adapter itself imports nothing.

Not published yet, or you want to vendor it: clone this repo and copy `argentic.ts`, `ai-sdk.ts` and `mastra.ts` into your project (Node 22+, no package needed beyond what you already use).

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

const client = new Argentic({ apiKey: process.env.ARGENTIC_API_KEY!, modelKey: process.env.MODEL_KEY })
const out = await runDurable({
  client, agent: 'my-agent', runId: 'order-1182', ledgerPath: '.argentic-ledger.json',
  task: 'Refund order 1182.', system: 'Call one tool per turn.',
  tools: await fromAiSdkTools(tools),
})
console.log(out.reply)
```

Keep `agent` and `runId` the same across restarts. `client.replay(agent, wakeId)` re-renders a wake's prompts from the journal and compares them to what the model saw; it calls no model and spends nothing.

## What to know

Delivery is at-least-once. An action that was running when the process died, before its result reached the local ledger, runs again on resume. Make your handlers safe to repeat: the AI SDK `toolCallId` your `execute` receives is a stable key (`agent:seq`) to dedupe on.

Mastra tools get the same key as `context.agent.toolCallId`.

Full walkthroughs: [`examples/ai-sdk`](../../examples/ai-sdk), [`examples/mastra`](../../examples/mastra).
