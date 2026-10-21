# crash-test

Kill your agent at each tool call, restart it, and see which side effects happened twice.

It works on any agent in any language, with or without Argentic. It runs your command, points your tools at a local sink, and kills the process at every call the sink sees. It only watches what arrives. It never looks inside your agent.

Prototype. Node 20 or newer, no dependencies.

## Run it

Point your agent's tool endpoints (refund, email, ticket, whatever your tools call) at `$CRASHTEST_SINK_URL`, then:

```
node crash-test.mjs -- node my-agent.js
```

fish works the same way. Anything after `--` is your agent's command.

The tool does this:

1. Runs the agent once, cleanly, to learn which calls it makes.
2. For each call, runs it again and kills the process there. It kills twice per call: `mid` (the sink applied the call but never answers, so the agent never sees the reply) and `done` (the sink answered, then the process dies).
3. Restarts the same command. Your agent gets `$CRASHTEST_STATE_DIR`, a folder that survives the kill, if it keeps its own checkpoints.
4. Compares what landed against the clean run.

An action counts once when it arrives with an `Idempotency-Key` it has already seen, because a receiver that honours the key would absorb it. Use `--no-dedupe` to count those as second effects too, which is the right view if your receiver ignores keys.

## What it reports

```
✗ kill done at #1 POST /refund_order   POST /refund_order landed 2× (expected 1), after the first one was acknowledged
✓ kill mid  at #2 POST /send_email     POST /send_email came again with the same key (1×), absorbed
```

- **duplicated**: an action landed more often than in the clean run.
- **lost**: an action never landed after the restart.
- **absorbed replay**: the action came again with the same key. Safe only if your receiver dedupes on it.
- **did not finish**: the restarted agent crashed or timed out.

Exit status is 0 when nothing was duplicated or lost, 1 when something was, and 2 when a trial could not finish or the setup is wrong. `--json` and `--md` write the full report.

## Examples

`examples/` holds four agents. `node test/self-test.mjs` runs the first three and checks that the verdict follows the agent.

| Agent | What it shows |
|---|---|
| `plain-agent.mjs` | A plain loop with no checkpoints. Every kill duplicates finished actions. |
| `keyed-agent.mjs` | Stable keys and a progress file. Clean when the receiver honours the key, flagged with `--no-dedupe`. |
| `lossy-agent.mjs` | Assumes the earlier run finished. Reports lost actions. |
| `argentic-agent.ts` | The Argentic quickstart agent. Needs `ARGENTIC_API_KEY`, `MODEL_KEY` and Node's `--experimental-transform-types`. |

## Limits

- It sees HTTP calls to the sink. Effects outside it (a file, a database row, SMTP) are not seen yet.
- It kills at the sink's call order. An agent that fires calls in parallel can reach the kill point in a different order on another run.
- It kills processes. It does not test a paused worker or a network partition.
- If your agent keeps state in its working directory, use `--copy-cwd` so trials do not share it.
