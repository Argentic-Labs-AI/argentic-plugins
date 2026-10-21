# Argentic + Vercel AI SDK: refund demo

Argentic runs the loop. Your AI SDK `tool()` definitions carry over. Kill the process mid-run, start it again, and it resumes without repeating a finished action. The run keeps proof of what ran.

The agent refunds an order, emails the customer, and closes the ticket. Each tool writes a line to `outbox.jsonl` so you can see that nothing happened twice.

## Quickstart (under 10 minutes)

Get the code first. The example imports the adapter from `../../adapters`, so clone the whole repo:

```bash
git clone https://github.com/Argentic-Labs-AI/argentic-plugins
cd argentic-plugins/examples/ai-sdk
```

1. Get an Argentic API key at https://getargentic.com/platform
2. Get a free NVIDIA NIM key at https://build.nvidia.com
3. Export both (bash or zsh):

   ```bash
   export ARGENTIC_API_KEY=aek_...
   export MODEL_KEY=nvapi-...
   ```

   fish:

   ```fish
   set -x ARGENTIC_API_KEY aek_...
   set -x MODEL_KEY nvapi-...
   ```

4. Install (Node 22+):

   ```bash
   npm install
   ```

5. Run once and crash after the first action (the refund):

   ```bash
   ARGENTIC_CRASH_AFTER=1 npm start
   ```

   fish: `env ARGENTIC_CRASH_AFTER=1 npm start`

6. Run again, same command without the variable:

   ```bash
   npm start
   ```

   You will see a line like `skip seq 7 refund_order: already done before` (your number may differ), then the email and ticket steps, then a one-line summary. The script also replays each wake and prints the outbox counts: one line per tool.

7. Open https://getargentic.com/platform, go to **Runs**, pick your agent (printed as `refund-demo-xxxxxx`) and open its oldest run (the one that crashed, at the bottom of the list). Under **Proof of what ran**, press **Check**: it rebuilds every prompt from the journal and compares it with what the model was sent. **Re-run** does the same for the engine's own decisions. Both are free.

Use `npm start -- --fresh` to start over with a new agent.

## Other models

The default is the free NVIDIA model. To use another, set `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN` and `ARGENTIC_PRICE_OUT`, and put that provider's key in `MODEL_KEY`.

## Tests

```bash
npm test
```

Runs offline against an in-process fake server: a crash after the first action, a rerun, each tool executed once, stored answers reused for the replayed step. It also covers a 409 and a 503 along the way.

## Honest limit

Delivery is at-least-once. If the process dies while an action is running, before its result is saved to the local ledger, that action runs again on resume. The tools here dedupe on the `toolCallId` the adapter passes in, which is stable for each action. Do the same in your own handlers.
