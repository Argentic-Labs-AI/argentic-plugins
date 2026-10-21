# crash-test

Kill your agent at each tool call, restart it, and see which side effects happened twice.

It works on any agent in any language, with or without Argentic. It runs your command, points your tools at local sinks (HTTP, a Stripe-shaped payments API, SMTP), and kills the process at every call a sink sees. It only watches what arrives. It never looks inside your agent.

Prototype. Node 20 or newer, no dependencies.

## 60-second demo

You need Node and this repo. No keys, no accounts. In fish or bash:

```
git clone https://github.com/Argentic-Labs-AI/argentic-plugins
cd argentic-plugins/crash-test
node crash-test.mjs -- node examples/plain-agent.mjs
node crash-test.mjs -- node examples/keyed-agent.mjs
```

The first agent is a plain loop that refunds an order, emails the customer and closes the ticket. Every kill point duplicates something, and the report says which action landed twice and whether the first copy had been acknowledged. The second agent sends a stable `Idempotency-Key` with each action and writes its progress to a file. It comes out clean.

Then change the receiver and run it again:

```
node crash-test.mjs --no-dedupe -- node examples/keyed-agent.mjs
```

Now the same keyed agent fails, because a receiver that ignores the key sees a second request. The verdict follows the receiver, not the agent.

## Run it on your agent

Point your agent's tool endpoints at the sinks the tool starts, then:

```
node crash-test.mjs -- node my-agent.js
```

Anything after `--` is your agent's command. Your agent gets these environment variables:

| Variable | What it is |
|---|---|
| `CRASHTEST_SINK_URL` | HTTP sink. Answers `200 {"ok":true}`. Paths under `/v1/` behave like a payments API. |
| `CRASHTEST_SMTP_URL`, `CRASHTEST_SMTP_HOST`, `CRASHTEST_SMTP_PORT` | SMTP sink. Accepts any mail. |
| `CRASHTEST_STATE_DIR` | A folder that survives the kill, for agents that keep checkpoints. |

The tool does this:

1. Runs the agent cleanly to learn which calls it makes.
2. For each call, runs it again and fails it one of three ways. `mid`: the sink applies the call but the agent never sees the reply, then the process is killed. `done`: the sink answers, then the process is killed. `pause`: the process is frozen with that call held back, a second copy starts, then the frozen one is let go. `pause` is a worker that was paused, not killed.
3. Restarts the same command.
4. Compares what landed against the clean run.

A repeat of an `Idempotency-Key` the sink has already seen counts as one effect, because a receiver that honours the key would absorb it. The `/v1/` paths do exactly that, the way a payments API does, and refuse a reused key with a different body. Use `--no-dedupe` to count repeats as second effects.

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

## Examples

| Agent | What it shows |
|---|---|
| `plain-agent.mjs` | A plain loop with no checkpoints. Every kill point duplicates finished actions. |
| `checkpoint-agent.mjs` | A progress file, no keys. Still duplicates the cut-off action and the one that landed just before the file write. |
| `keyed-agent.mjs` | Stable keys and a progress file. Clean when the receiver honours the key. |
| `payments-agent.mjs` | Refunds through the Stripe-shaped API. `PAY_KEYED=1` sends the key. |
| `mail-agent.mjs` | Sends mail over SMTP. `SMTP_KEYED=1` sets a stable key header. |
| `wandering-agent.mjs` | A stand-in for an LLM agent that varies its route. `WANDER_KEYED=1` makes it careful. |
| `lossy-agent.mjs` | Assumes the earlier run finished. Reports lost actions. |
| `argentic-agent.ts` | The Argentic quickstart agent. Needs `ARGENTIC_API_KEY`, `MODEL_KEY`, and `node --experimental-transform-types`. |

`node test/self-test.mjs` runs thirteen of these cases and checks that the verdict follows the agent.

## Limits

- It sees what arrives at the HTTP and SMTP sinks. A file write or a database row is not seen.
- Kill points follow the sink's call order. An agent that fires calls in parallel can reach the same point in a different order on another run.
- It kills at calls. It does not kill between a model call and the next tool call.
- It has not been run against a live model yet. The agents here use fixed plans or a scripted model.
- If your agent keeps state in its working directory, use `--copy-cwd` so trials do not share it.
