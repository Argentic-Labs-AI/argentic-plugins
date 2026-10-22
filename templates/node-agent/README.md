# Node agent: one file, no framework

A support agent in one file (`index.ts`, about 100 lines) for people who don't use Next.js. It looks up an order and sends one email into a local outbox. Press **Ctrl-C** while it works, run it again, and the outbox still has one email. Then it checks the run against Argentic's journal.

The tools are Vercel AI SDK `tool()` objects. [Argentic](https://getargentic.com/docs) runs the loop and keeps the journal. Your code carries out each action. For the web app version with a Kill button, see [`../support-agent`](../support-agent/).

## Run it

You need Node 22 or newer, an Argentic API key (https://getargentic.com/platform, under Keys) and a model key. The default model is a free NVIDIA one; get a key at https://build.nvidia.com.

```
npm install
export ARGENTIC_API_KEY=aek_...
export MODEL_KEY=nvapi-...
npm start
```

fish:

```
set -x ARGENTIC_API_KEY aek_...
set -x MODEL_KEY nvapi-...
npm start
```

Or copy `.env.example` and load it however you like. Nothing reads `.env` by itself.

1. Run it and wait for `lookup_order` to finish. `send_email` takes about two and a half seconds, because the sandbox "provider" is slow on purpose.
2. Press Ctrl-C while `send_email` is working. The message has already left, and the run has not heard back yet.
3. Run `npm start` again from the same folder. It resumes the same run: finished actions are skipped, `send_email` runs again with the same key, and the provider says it already has it.
4. The end of the output counts the lines in `.agent/outbox.jsonl` (1), then replays each wake against the journal (`all match`) and prints a link to the run in the dashboard.

Don't want to race the keyboard? `npm run kill-demo` starts a new run and kills the process for you after two actions. `--fresh` starts over.

## What to know

- A cut-off action runs again on resume. It is safe because every action carries a stable key (`<agent>:<seq>`, passed to your tool as `toolCallId`) and the "provider" keeps one message per key. A real provider has to dedupe by key too; Resend takes an `Idempotency-Key` header. A tool with no way to dedupe can still send twice.
- State is in `./.agent` (the run id, the ledger of finished actions, the outbox). Delete it or pass `--fresh` for a new run.
- `send_email` lists its properties shortest name first. Argentic can store a run's tools as jsonb, which sorts keys that way; listing them in that order keeps the replay check matching either way.
- This shows crash recovery and proof of what ran, not the agent's memory.

MIT · [Argentic docs](https://getargentic.com/docs) · [AI SDK guide](https://getargentic.com/docs/frameworks/ai-sdk)
