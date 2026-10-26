# crash-test

Kill your agent at each tool call, restart it, and see which side effects happened twice.

It works on any agent in any language, with or without Argentic. It runs your command, points your tools at local stand-ins (HTTP, a Stripe-shaped payments API, SMTP, files, SQLite rows), and kills the process at every effect they see and between a model reply and the tool call that follows it. It only watches what arrives. It never looks inside your agent.

Version 0.1. Node 22 or newer on macOS or Linux (Windows through WSL). No dependencies, no keys, no network, no account.

## Quickstart (30 seconds)

```
npx @argentic-labs/crash-test --demo
```

That runs a small agent bundled with the tool: it refunds an order, emails the customer and closes the ticket, with no safeguards. The tool kills it at each of those actions, restarts it, and shows what landed twice. You will see the refund go out twice. The exit code is 1.

Now your own agent. Point its tool calls at `$CRASHTEST_SINK_URL` (a call to `https://api.example.com/refund` becomes `$CRASHTEST_SINK_URL/refund`) and put its command after the `--`:

```
npx @argentic-labs/crash-test -- node my-agent.js
npx @argentic-labs/crash-test -- python3 agent.py
```

Your agent must exit 0 when its work is done, so the tool can tell a finished restart from a broken one. It does not matter what language or framework it is written in, or whether it has anything to do with Argentic. The rest of this page covers fixing what it finds, other kinds of effects, and CI.

## Walkthrough (5 minutes)

You need Node 22+ and git. The examples use a scripted model, so nothing here calls a paid model or needs an account.

### 1. Get the examples

```
git clone https://github.com/Argentic-Labs-AI/argentic-plugins
cd argentic-plugins/crash-test
node crash-test.mjs --help
```

### 2. Watch an agent double-send

`examples/ai-sdk/naive.mjs` is a small support agent on the Vercel AI SDK. It refunds an order, emails the customer and closes the ticket, with plain tools and nothing else.

```
cd examples/ai-sdk
npm install
node ../../crash-test.mjs -- node naive.mjs
```

The tool runs the agent once to learn what it does (three actions), then runs it six more times and kills it each time at one of those actions, once before the agent hears back and once right after. Each time it restarts the agent and counts what landed. The naive agent starts from the top on every restart, so:

```
By action
  Action              Clean run  Worst  Repeated in  Verdict
  POST /refund_order  1×         2×     6 of 6       REPEATED
  POST /send_email    1×         2×     4 of 6       REPEATED
  POST /close_ticket  1×         2×     2 of 6       REPEATED
```

The customer got refunded twice. The exit code is 1.

### 3. Fix it and run it again

`safe.mjs` is the same agent with one change: each tool sends an `Idempotency-Key` built from the thing it acts on (`refund:1182`, `close:T-77`). Compare the two files to see it.

```
node ../../crash-test.mjs -- node safe.mjs
```

Nothing is duplicated, nothing is lost, and the exit code is 0. The report lists "absorbed replays": actions that came again with the same key. They are harmless only if the service on the other end honours the key, as payment APIs do. To see what happens when it does not:

```
node ../../crash-test.mjs --no-dedupe -- node safe.mjs
```

The same agent now fails at every kill point. The verdict follows the receiver, so check that yours dedupes on the key.

### 4. Run it on your agent

See the quickstart above: point your tool calls at `$CRASHTEST_SINK_URL` and put your command after the `--`. If your agent keeps state in its working directory, add `--copy-cwd` so trials do not share it:

```
node crash-test.mjs --copy-cwd -- python3 agent.py
```

Other kinds of effects (email, files, a database, a model API) are in the sections below.

### 5. Use it in CI

The exit code is the verdict, and `--json` gives you the details:

```
npx @argentic-labs/crash-test --json report.json -- node my-agent.js
```

| Exit code | Meaning |
|---|---|
| 0 | Every action landed as often as in the clean run. |
| 1 | An action landed twice or never. |
| 2 | The setup is wrong, or a trial could not finish (the agent crashed or timed out on restart). |

`--json -` writes the JSON to stdout and the readable report to stderr, so you can pipe it: `npx @argentic-labs/crash-test --json - -- node my-agent.js 2>/dev/null | jq .summary`. `--md report.md` writes a Markdown version.

The report has the verdict for each kill point, a table with one row per action (how many times it ran in the clean run, the worst case, in how many trials it repeated), and a summary. When something repeated it ends with one line about Argentic; `--no-promo` removes it.

Two more agents that need no install: `node crash-test.mjs -- node examples/plain-agent.mjs` fails, and `keyed-agent.mjs` passes.

## Environment your agent gets

Anything after `--` is your agent's command. Your agent gets these environment variables:

| Variable | What it is |
|---|---|
| `CRASHTEST_SINK_URL` | HTTP sink. Answers `200 {"ok":true}`. Paths under `/v1/` behave like a payments API. |
| `CRASHTEST_SMTP_URL`, `CRASHTEST_SMTP_HOST`, `CRASHTEST_SMTP_PORT` | SMTP sink. Accepts any mail. |
| `CRASHTEST_FILES_DIR` | A folder for effect logs. Every complete line appended to a file in it is one effect. A line that is JSON with a `key` or `idempotency_key` field carries that key. Checkpoints belong in the state folder, not here. |
| `CRASHTEST_DB_PATH` | A SQLite file (Node 22.13 or newer). Every row inserted into any table is one effect; a column named `idempotency_key` or `key` is its key. Use `INSERT OR IGNORE` against a unique key and the second copy never exists. |
| `CRASHTEST_STATE_DIR` | A folder that survives the kill, for agents that keep checkpoints. |
| `CRASHTEST_UPSTREAM_<NAME>_URL` | A pass-through to a service you name with `--upstream name=url`, such as a model API. See below. |

The tool does this:

1. Runs the agent cleanly to learn which calls it makes.
2. For each call, runs it again and fails it one of three ways. `mid`: the sink applies the call but the agent never sees the reply, then the process is killed. `done`: the sink answers, then the process is killed. `pause`: the process is frozen with that call held back, a second copy starts, then the frozen one is let go. `pause` is a worker that was paused, not killed.
3. Restarts the same command.
4. Compares what landed against the clean run.

For files and rows the tool sees the effect just after it happens, so `mid` and `done` are the same kill there. `pause` still works: the agent is frozen right after its write.

A repeat of an `Idempotency-Key` the sink has already seen counts as one effect, because a receiver that honours the key would absorb it. The `/v1/` paths do exactly that, the way a payments API does, and refuse a reused key with a different body. Use `--no-dedupe` to count repeats as second effects.

## Kills between a model reply and its tool call

Give the tool the model API with `--upstream`, and have your agent send its model calls to `$CRASHTEST_UPSTREAM_MODEL_URL` instead of the provider (the name you chose, in capitals):

```
MODEL_KEY=... node crash-test.mjs --upstream model=https://integrate.api.nvidia.com/v1 --upstream-rpm 10 -- node examples/llm-agent.mjs
```

The tool forwards each call untouched, counts it, and adds two kill points per call: `after reply` (the reply reaches the agent, then SIGKILL, so the tool call it asked for never happens) and `reply lost` (the provider answered, the agent never heard). Upstream calls are not effects and are not counted as duplicates. `--upstream-rpm` caps requests per minute across the whole run, which matters on a shared free key. Replies are buffered, so streaming responses do not pass. Any HTTP service works, not only models: point an agent that talks to an orchestration API at it the same way.

## What it reports

```
✗ done  at #1 POST /refund_order   POST /refund_order landed 2× (expected 1), after the first one was acknowledged
✓ mid   at #2 POST /send_email     POST /send_email came again with the same key (1×), absorbed
~ mid   at #3 POST /add_note       path diverged at call 3: the clean run made POST /close_ticket, this run made POST /add_note
```

- **duplicated**: an action landed more often than in the clean run.
- **lost**: an action never landed after the restart, though every clean run did it.
- **absorbed replay**: the action came again with the same key. Safe only if your receiver dedupes on it.
- **path diverged**: the agent chose different calls than the clean run did before the kill. It is reported, and it is not a failure by itself.
- **did not finish**: the restarted agent crashed or timed out.

Exit status is 0 when nothing was duplicated or lost, 1 when something was, and 2 when a trial could not finish or the setup is wrong. `--json` and `--md` write the full report.

## Agents that take different paths

An LLM agent may make different calls on each run. Three options handle that:

- `--samples 5` runs the agent cleanly five times. A duplicate is measured against the most any clean run did, and an action counts as lost only if every clean run did it.
- `--intent order_id,to` identifies an action by those body fields as well as its route, so "refund order 1182" is the same action however the agent got there. For mail, `--intent subject` tells two messages to the same address apart.
- The report says where a trial's opening calls first left every clean run. Lost work is not checked in those trials, but duplicates still are.
- An action that no clean run made, landing once after a restart, is reported as a different route (`~`), not as a repeat. It counts as duplicated only if it lands twice.

## Examples

| Agent | What it shows |
|---|---|
| `ai-sdk/naive.mjs` | A Vercel AI SDK agent with plain tools. Repeats finished actions after a kill. Needs `npm install` in `examples/ai-sdk`. |
| `ai-sdk/safe.mjs` | The same agent with an `Idempotency-Key` per action. Clean when the receiver honours the key. To use a real model, replace `scriptedModel()` with your provider's model. |
| `plain-agent.mjs` | A plain loop with no checkpoints. Every kill point duplicates finished actions. This is what `--demo` runs. |
| `python-agent.py` | The same plain loop in Python, standard library only. Shows that the language does not matter. |
| `checkpoint-agent.mjs` | A progress file, no keys. Still duplicates the cut-off action and the one that landed just before the file write. |
| `keyed-agent.mjs` | Stable keys and a progress file. Clean when the receiver honours the key. |
| `payments-agent.mjs` | Refunds through the Stripe-shaped API. `PAY_KEYED=1` sends the key. |
| `mail-agent.mjs` | Sends mail over SMTP. `SMTP_KEYED=1` sets a stable key header. |
| `wandering-agent.mjs` | A stand-in for an LLM agent that varies its route. `WANDER_KEYED=1` makes it careful. |
| `file-agent.mjs` | The effect is a line in an outbox file. `FILE_KEYED=1` adds a key. Use `--intent tool`. |
| `db-agent.mjs` | The effect is a SQLite row. `DB_KEYED=1` makes the database refuse the second copy. Run with `node --no-warnings`. |
| `llm-agent.mjs` | A real tool-calling loop against an OpenAI-compatible API. `LLM_KEYED=1` makes it careful. Use `--upstream`. |
| `lossy-agent.mjs` | Assumes the earlier run finished. Reports lost actions. |
| `argentic-agent.ts` | The Argentic quickstart agent (in the repo, not in the npm package). Needs `ARGENTIC_API_KEY`, `MODEL_KEY`, and `node --experimental-transform-types`. |

`npm test` (or `node test/self-test.mjs`) runs thirty-seven cases and checks that the verdict follows the agent, the exit codes, and the JSON report. It needs no keys and no network; it uses a scripted model. The AI SDK cases run once you have run `npm install` in `examples/ai-sdk`, and are skipped with a note until then.

## Limits

- Files are read as append-only logs (a rewritten file counts as new lines), and rows are insert-only. An update or delete is not seen.
- Other databases are not supported yet. SQLite only.
- Kill points follow the sink's call order. An agent that fires calls in parallel can reach the same point in a different order on another run.
- Between a model reply and a tool call it can only kill at calls that go through `--upstream`. A model called from inside another service is reached only at the call your agent makes to that service.
- Most examples use fixed plans or a scripted model. `llm-agent.mjs` is the one that calls a real model.
- If your agent keeps state in its working directory, use `--copy-cwd` so trials do not share it.
- Windows is not supported directly (the agent command runs through `sh`); use WSL.
