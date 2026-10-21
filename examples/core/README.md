# Argentic with no framework: refund demo

Argentic runs the loop. Your tools are plain objects: a name, a description, a JSON schema and a handler. Kill the process mid-run, start it again, and it resumes without repeating a finished action. The run keeps proof of what ran.

The agent refunds an order, emails the customer, and closes the ticket. Each tool writes a line to `outbox.jsonl` so you can see that nothing happened twice.

## Quickstart (under 10 minutes)

Get the code first. The example imports the adapter from `../../adapters`, so clone the whole repo:

```bash
git clone https://github.com/argentic-labs-ai/argentic-plugins
cd argentic-plugins/examples/core
```

1. Get an Argentic API key at https://argentic-labs.vercel.app/platform
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

4. Install (Node 22+). The only packages are `tsx` and TypeScript, to run the file:

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

   You will see `skip seq 7 refund_order: already done before` (your number may differ), then the email and ticket steps, then a one-line summary. The script also replays each wake and prints the outbox counts: one line per tool.

7. Open https://argentic-labs.vercel.app/platform, go to **Runs**, pick your agent (printed as `refund-demo-xxxxxx`) and open its oldest run (the one that crashed, at the bottom of the list). Under **Proof of what ran**, press **Check**: it rebuilds every prompt from the journal and compares it with what the model was sent. **Re-run** does the same for the engine's own decisions. Both are free.

Use `npm start -- --fresh` to start over with a new agent.

## Your own tools

```ts
import { Argentic, runDurable, type DurableTool } from '../../adapters/typescript/argentic.ts'

const tools: DurableTool[] = [{
  name: 'close_ticket',
  description: 'Close a support ticket with a note.',
  parameters: { type: 'object', properties: { ticket_id: { type: 'string' }, note: { type: 'string' } }, required: ['ticket_id', 'note'] },
  execute: (args, { idempotencyKey }) => closeTicket(args.ticket_id, args.note, idempotencyKey),
}]
```

Pass them to `runDurable` with an `agent` and a `runId` you keep the same across restarts. See [`refund.ts`](refund.ts) for the whole thing.

## Tests

```bash
npm test
```

Runs offline against an in-process fake server: a crash after the first action, a rerun, each tool executed once, stored answers reused for the replayed step. It also covers a 409 and a 503 along the way.

## Honest limit

Delivery is at-least-once. If the process dies while an action is running, before its result is saved to the local ledger, that action runs again on resume. The tools here dedupe on `idempotencyKey` (`agent:seq`), which is stable for each action. Do the same in your own handlers.
