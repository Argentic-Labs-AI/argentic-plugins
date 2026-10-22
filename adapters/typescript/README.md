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
- `@argentic-labs/client/ai-sdk`: `fromAiSdkTools`, needs `ai` v5, v6 or v7.
- `@argentic-labs/client/tools`: `toolPack`, retry-safe tools for Stripe, Resend, SMTP, Slack, GitHub and a generic HTTP POST. See [TOOLS.md](TOOLS.md).
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

// apiKey defaults to ARGENTIC_API_KEY and modelKey to MODEL_KEY
const client = new Argentic()
const out = await runDurable({
  client, agent: 'my-agent', runId: 'order-1182', ledgerPath: '.argentic-ledger.json',
  task: 'Refund order 1182.', system: 'Call one tool per turn.',
  tools: await fromAiSdkTools(tools),
})
console.log(out.reply)
```

Keep `agent` and `runId` the same across restarts. A request that takes longer than `timeoutMs` (default 300000, 0 for no limit) counts as a network failure and is retried with the same key. If the ledger file is not valid JSON, `runDurable` warns on stderr, sets the file aside as `<path>.corrupt` and starts empty, so finished actions may run again. `client.replay(agent, wakeId)` re-renders a wake's prompts from the journal and compares them to what the model saw; it calls no model and spends nothing.

## Waking on a schedule (handleDue)

Beta, and off by default on the hosted API. When an agent falls due (a plan's `wake_at`, a schedule, a timer or a hook event), Argentic POSTs a signed notice to the `wake_url` you registered. The notice names the agent and why it is due and carries no agent content and no model key. `handleDue` checks the signature and the time, then wakes the agent with `fire_due` on your own model key.

The secret (`whsec_...`) is shown once, when you register the `wake_url`. Store it like a password, for example as `ARGENTIC_WEBHOOK_SECRET`. The model key stays on your server: set `MODEL_KEY` there, as for any other wake.

```ts
import { Hono } from 'hono'
import { handleDueResponse } from '@argentic-labs/client'

const app = new Hono()
// Reads ARGENTIC_API_KEY, MODEL_KEY and ARGENTIC_WEBHOOK_SECRET from the environment.
app.post('/argentic/due', (c) => handleDueResponse(c.req.raw))
```

`handleDueResponse` answers 200 when the agent was woken, 401 if the signature or time is wrong, 400 if the body is not an `agent.due` notice, 500 if the secret is missing or malformed, and 502 if the wake itself failed (the notice is then sent again). It takes a Fetch `Request` or `{ body, headers }` with the raw body text, and works the same in a Next.js route handler. `handleDue(request, { secret, client, model, toleranceSeconds })` returns `{ notice, wake }` and throws `WebhookVerificationError` (with a `code`) before any call is made. `verifyDue(request)` only verifies and parses, so you can queue the notice and wake later. The wake uses the notice's `webhook-id` as its idempotency key, so a notice delivered twice replays the first wake instead of waking twice. Timestamps more than 300 seconds off are refused.

## What to know

Delivery is at-least-once. An action that was running when the process died, before its result reached the local ledger, runs again on resume. Make your handlers safe to repeat: the AI SDK `toolCallId` your `execute` receives is a stable key (`agent:seq`) to dedupe on.

Mastra tools get the same key as `context.agent.toolCallId`.

Full walkthroughs: [`examples/ai-sdk`](../../examples/ai-sdk), [`examples/mastra`](../../examples/mastra).
