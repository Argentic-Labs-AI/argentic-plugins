# Support agent you can kill mid-run

A Next.js support agent that reads a ticket, looks up the order and sends one email. Press **Kill** while it works, then **Resume**. The agent carries on from where it stopped and the sandbox inbox still shows one email. A **Proof of what ran** panel re-checks the run against Argentic's journal.

It is built on the [Vercel AI SDK](https://ai-sdk.dev): the two tools are ordinary `tool()` objects. [Argentic](https://getargentic.com/docs) runs the agent loop, journals every step and hands each tool call back to your code as an action with a stable key.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FArgentic-Labs-AI%2Fargentic-plugins%2Ftree%2Fmain%2Ftemplates%2Fsupport-agent&project-name=argentic-support-agent&repository-name=argentic-support-agent&env=ARGENTIC_API_KEY&envDescription=Your%20Argentic%20API%20key%20%28aek_...%29.%20Make%20one%20at%20getargentic.com%2Fplatform%20under%20Keys.&envLink=https%3A%2F%2Fgetargentic.com%2Fplatform)

## What you need

- An Argentic API key (`aek_...`): make one at https://getargentic.com/platform under Keys. It goes in `ARGENTIC_API_KEY`.
- A model key. The default model is a free NVIDIA one: get a key at https://build.nvidia.com (it starts with `nvapi-`). Paste it into the page. It stays in the tab and is forwarded to Argentic with each call; this app does not store it. For `npm run dev` you can put it in `MODEL_KEY` instead. A deployed site ignores `MODEL_KEY` on purpose, so nobody can run your model key up. Don't try to work around that on a public deployment.

## Run it locally

Node 22 or newer.

```
npm install
cp .env.example .env.local
npm run dev
```

Put your key in `.env.local`, open http://localhost:3000 and press Run agent. You have about two and a half seconds per action to press Kill: the best moment is while `send_email` is working.

## What you will see

1. **Run agent.** Turn 1 asks the model, which looks up order 1182 and sends the email. The sandbox inbox shows it with the key it was sent under.
2. **Kill** during `send_email`. The mail provider has already taken the message; the run has not heard back yet.
3. **Resume.** The same run id and the same keys go back to Argentic. Turn 1 comes straight from the journal without calling the model again, `lookup_order` is skipped because it finished, `send_email` runs again with the same key and the provider answers "already have this key". The inbox still says 1.
4. **Check.** Argentic re-renders each prompt from its journal and compares it with what the model was sent. It costs nothing. The link opens the same run in the dashboard.

A cut-off action runs again on resume. It is safe because every action carries a stable key (`${agent}:${seq}`) and the provider keeps one message per key. Resend takes an idempotency key the same way. If your own tool has no way to dedupe, it can still send twice: the key is what makes a retry harmless, not the resume.

## Make it yours

| To change | Edit |
|---|---|
| The tools (add a refund, a CRM lookup, a real email) | `lib/tools.ts`: plain AI SDK `tool()` objects. Use `toolCallId` as the idempotency key for anything with a side effect. |
| The agent's instructions and the ticket | `system`, `ticket` and `task` in `lib/tools.ts` |
| The model | `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN`, `ARGENTIC_PRICE_OUT` (prices are dollars per million tokens) |
| The loop | `lib/run.ts`: wake, run the actions it asks for, write each result down, hand the results back. About 80 lines. |
| Where state lives | `lib/store.ts` |

To send real email, replace `deliver()` in `lib/tools.ts` with a call to your provider and pass `mail.key` as its idempotency key.

## Keeping a run between requests on Vercel

Each visitor's run (which actions finished, the sandbox inbox) lives in a small store. Without setup it is a file in the server's temp folder: fine locally, but on Vercel a later request can land on another instance and find nothing. For a deployment other people will use, open the Storage tab of your Vercel project, add **Upstash Redis** and redeploy. The variables fill in by themselves (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_*`). Closing the tab counts as a kill too, and the run is still there when you come back.

## Files

```
app/page.tsx, components/Console.tsx   the single page
app/api/run                            streams the run (one JSON line per change)
app/api/kill, reset, session, proof    Kill flag, start over, current state, replay check
lib/tools.ts                           the two tools, the sandbox mail provider, the prompt
lib/run.ts                             the durable loop
lib/store.ts, lib/session.ts           state
test/run.test.ts                       kill after the mail left, resume, one email (offline)
```

`npm test` runs the offline test against a scripted Argentic API. `npm run typecheck` checks the types.

## Before you put a real tool behind it

The page is public and every visitor can start a run, which spends your Argentic quota. It allows 20 runs per IP address per hour (`RUNS_PER_IP_HOUR`). A real email, refund or payment tool also needs an approval step and an allowlist (who it may email, what it may refund) before you swap it in for the sandbox. A model can be talked into things by whatever is in a ticket.

## Limits

- The free beta allows 30 requests a minute, 20 turns and 10 minutes per call. The free NVIDIA model is rate limited; if a run stops with `provider_rate_limited`, wait half a minute and press Resume.
- The sandbox inbox is not an email service. Nothing leaves the app.
- This template shows crash recovery and proof of what ran. It does not show the agent's memory.

[Argentic docs](https://getargentic.com/docs) · [AI SDK guide](https://getargentic.com/docs/frameworks/ai-sdk) · MIT
