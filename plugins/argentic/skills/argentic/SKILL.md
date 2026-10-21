---
name: argentic
description: Use when building, testing or debugging something that runs agents on the Argentic Engine API (wake an agent, read its memory, declare its tools, scheduled wakes, spend limits), or when argentic_* MCP tools are available.
---

# Building on Argentic

Argentic runs an agent on a model you choose, on your own model key, and keeps that agent's memory between calls. You send a message to an agent id. You get a reply back, plus what it did and what it cost.

Full reference: https://getargentic.com/docs

## The MCP tools

One MCP, `argentic`, signed in with the user's Argentic account and an organization. It has account tools (`get_account`, `list_api_keys`, `create_api_key`, `revoke_api_key`, `get_usage`, `set_budget`) and these agent tools, which map one to one onto the REST routes:

| tool | what it does | spends money |
|---|---|---|
| `argentic_wake` | message an agent, get its reply | yes |
| `argentic_fire_due` | wake an agent on plans that have fallen due | yes, if something is due |
| `argentic_resume` | finish a wake that was cut off or stopped on a cap | yes |
| `argentic_wakes`, `argentic_wake_get` | find wakes that never answered, read one wake | no |
| `argentic_journal` | read everything the agent did, in pages | no |
| `argentic_replay` | check the journal still reproduces what the model was shown | no |
| `argentic_memory` | read an agent's decisions, facts or plans, with optional text search | no |
| `argentic_due` | list plans whose wake time has passed | no |
| `argentic_get_tools`, `argentic_set_tools` | read or replace the tools stored for an agent (set needs owner or admin) | no |
| `argentic_approvals`, `argentic_answer_approval` | spend-cap requests (answering needs owner or admin) | approving lets an agent spend more |

Account questions (usage, budget, API keys) use the account tools. Without the MCP, call `POST /v1/agents/{agent}/wake` and the other routes directly with `Authorization: Bearer aek_...` (an API key from `create_api_key` or the dashboard) and, for wakes, `X-Model-Key: <provider key>`.

## Rules that matter

- The agent id is the memory. The same id keeps the same memory, and different ids never see each other. One id per end user, project or task is the usual shape. Ids are 1 to 64 letters, digits, `-` or `_`.
- Every wake costs real money on the user's model key. Pass `model.prices` (dollars per million tokens) so the spend limits count correctly, and keep `max_usd` small while testing. Each call carries roughly 2,500 to 5,000 prompt tokens of engine overhead, so one-word test calls are not free.
- The model key never goes in a tool argument or a message. It travels in the `X-Model-Key` header of the connection, and only wake tools (`argentic_wake`, `argentic_fire_due`, `argentic_resume`) need it. If a wake says `model_key_required`, tell the user to add it to the connection or plugin settings.
- An agent runs one call at a time. A second call while it is running returns `status: "queued"` (HTTP 409 on REST) with `retry_after` seconds. Wait that long and send it again.
- The agent decides what to remember. It records with built-in tools (`decide`, `supersede`, `plan`, `plan_close`, `recall` and a few more; they show up in `tool_calls.names`). To see what it kept, call `argentic_memory`. Do not assume a fact was stored because you said it.

## Statuses

`done` finished. `queued` another call is running. `spend_cap` or `budget_cap` a limit stopped it and the work so far is kept. `turn_cap` ran out of turns. `error` the model call failed (the reply says why). `approval_required` a cap was hit and approvals are on for the account; ask the human before approving anything.

Errors come back as `{ error, detail }`. The ones you will meet: `unauthorized` (sign in again via `/mcp`), `rate_limited` (wait `retry_after`), `bad_request` (read `detail`), `bad_model` and `model_key_rejected` (the provider refused; nothing was spent), `payment_required`.

## Your own tools

An agent can call tools you declare. Nothing on Argentic's side calls your systems: each call is recorded and returned in `actions`, and your app carries it out. The agent is told it will not see the result in that run.

Declare them once with `argentic_set_tools`, or send `tools` with a wake (those win for that call). Limits: at most 8 tools, names `[a-z][a-z0-9_]*` up to 40 characters, parameters a flat object schema with string, number, integer, boolean or array properties. Do not reuse a built-in name.

The loop: wake, read `actions`, do them, wake again with what happened.

## When a call does not answer

Every wake is recorded before it runs. If a wake times out, the connection drops or it stops on a cap:

1. Retry safely by sending the same `idempotency_key` with `argentic_wake`. The retry does not add the message twice, and repeats the stored answer if the wake finished.
2. Or look: `argentic_wakes` with `state: "open"` lists wakes that are not done (`interrupted` means the process died).
3. `argentic_resume` continues the latest open wake without adding its message again. It needs the model key again. Anything you send, such as a higher `max_usd`, replaces what the wake had.

What resume does: a tool call that already finished is not run again. A tool call that was cut off is requested again once, so if your side effects matter, de-duplicate on the action's `seq`. A model call that was lost is asked again and charged at its estimate. If another run still holds the agent you get `queued`; a run that died holds it for up to two minutes.

## The journal

`argentic_journal` returns the append-only record of what the agent did, oldest first, in pages. It holds what your messages and your tools' outputs held, so treat it as your own data. `argentic_replay` re-renders each turn's prompt and compares it with the hash recorded when the model was called: `match: true` means the journal still reproduces that prompt byte for byte. It does not re-run the model or call your tools. A downloadable journal file with a SHA-256 hash chain exists as `GET /v1/agents/{agent}/journal/bundle` (not an MCP tool, it can be 4 MB). The chain shows the file was not edited after the fact; it is not signed, so it is not proof to a third party.

## Scheduled work

Agents do not wake themselves. Wake with `schedule: true` and the agent may make plans with a wake time. You poll `argentic_due`, and for each agent with something due call `argentic_fire_due`. If you do not poll, leave `schedule` off; the agent is then told not to promise reminders.

## Do not claim

Check https://getargentic.com/docs for the current list. There is no streaming. Do not say the journal is signed or tamper-proof, and do not say a replay re-ran the model. Say what a call actually returned.
