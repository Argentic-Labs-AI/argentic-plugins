# Node agent: one file, no framework

A support agent in one file (`index.ts`, about 150 lines) for people who don't use Next.js. It looks up an order and sends one email into a local outbox. Press **Ctrl-C** while it works, run it again, and the outbox still has one email.

The loop is your own Vercel AI SDK `generateText`, and the tools are ordinary `tool()` objects. [Argentic](https://getargentic.com/docs) journals each model step and tool call, and serves the recorded ones back when the same run starts again (`durableRun`, "keep your loop"). For the web app version with a Kill button, where Argentic runs the loop, see [`../support-agent`](../support-agent/).

## Run it

You need Node 22 or newer, an Argentic API key (https://getargentic.com/platform, under Keys) and a model key. The default model is a free NVIDIA one; get a key at https://build.nvidia.com. Your app calls the model itself with that key; Argentic never sees it in this mode. Any OpenAI-compatible provider works: set `MODEL_BASE_URL` and `MODEL_ID`.

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
3. Run `npm start` again from the same folder. It resumes the same run: recorded model steps are not sent to the model again, finished actions are skipped, `send_email` runs again with the same key, and the provider says it already has it.
4. The end of the output counts the lines in `.agent/outbox.jsonl` (1).

Don't want to race the keyboard? `npm run kill-demo` starts a new run and kills the process for you after two actions. `--fresh` starts over.

## What to know

- A cut-off action runs again on resume. It is safe because every action carries a stable key (`run.keyFor(toolCallId)`, like `<agent>:<run>:m1.t0`) and the "provider" keeps one message per key. A real provider has to dedupe by key too; Resend takes an `Idempotency-Key` header. A tool with no way to dedupe can still send twice. Tools named in `dedupesOnKey` may run again; any other tool that was cut off stops the run for you to settle (see the [package README](../../adapters/typescript/README.md#keep-your-loop-durablerun)).
- State is in `./.agent` (the run id, the ledger of finished actions, the outbox). Delete it or pass `--fresh` for a new run.
- Keep your loop is a beta feature and is off by default on the hosted API. If your account does not have it, the template says so and runs the older mode, where Argentic runs the loop and the end of the output replays each wake against the journal. `--loop argentic` picks that mode on purpose. In that mode keep the order of `send_email`'s properties as written, because the replay check compares the tool list from one wake to the next.
- In keep-your-loop mode the journal records what your app reported, and the proof check (`client.replay`) does not apply. See the package README for what this mode does and does not give you.
- This shows crash recovery, not the agent's memory.

MIT · [Argentic docs](https://getargentic.com/docs) · [AI SDK guide](https://getargentic.com/docs/frameworks/ai-sdk)
