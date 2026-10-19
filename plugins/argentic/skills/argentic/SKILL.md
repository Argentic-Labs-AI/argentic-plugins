---
name: argentic
description: Use when building, testing or debugging something that runs agents on the Argentic Engine API (wake an agent, read its memory, declare its tools, scheduled wakes, spend limits), or when argentic_* MCP tools are available.
---

# Building on Argentic

Argentic runs an agent on a model you choose, on your own model key, and keeps that agent's memory between calls. You send a message to an agent id. You get a reply back, plus what it did and what it cost.

Full reference: https://argentic-labs.vercel.app/docs

## The MCP tools

If the `argentic` MCP server is connected, these map one to one onto the REST routes:

| tool | what it does | spends money |
|---|---|---|
| `argentic_wake` | message an agent, get its reply | yes |
| `argentic_fire_due` | wake an agent on plans that have fallen due | yes, if something is due |
| `argentic_memory` | read an agent's decisions, facts or plans, with optional text search | no |
| `argentic_due` | list plans whose wake time has passed | no |
| `argentic_get_tools`, `argentic_set_tools` | read or replace the tools stored for an agent | no |
| `argentic_usage` | your limits and what recent days cost | no |
| `argentic_billing`, `argentic_billing_checkout` | plan balance, payment link | no |
| `argentic_approvals`, `argentic_answer_approval` | spend-cap requests | approving lets an agent spend more |

Without the MCP server, call `POST /v1/agents/{agent}/wake` and the other routes directly with `Authorization: Bearer aek_...` and, for wakes, `X-Model-Key: <provider key>`.

## Rules that matter

- The agent id is the memory. The same id keeps the same memory, and different ids never see each other. One id per end user, project or task is the usual shape. Ids are 1 to 64 letters, digits, `-` or `_`.
- Every wake costs real money on the user's model key. Pass `model.prices` (dollars per million tokens) so the spend limits count correctly, and keep `max_usd` small while testing. Each call carries roughly 2,500 to 5,000 prompt tokens of engine overhead, so one-word test calls are not free.
- The model key never goes in a tool argument or a message. It travels in the `X-Model-Key` header of the connection. If a wake says `model_key_required`, tell the user to add it to the connection or plugin settings.
- An agent runs one call at a time. A second call while it is running returns `status: "queued"` (HTTP 409 on REST) with `retry_after` seconds. Wait that long and send it again.
- The agent decides what to remember. It records with built-in tools (`decide`, `supersede`, `plan`, `plan_close`, `recall` and a few more; they show up in `tool_calls.names`). To see what it kept, call `argentic_memory`. Do not assume a fact was stored because you said it.

## Statuses

`done` finished. `queued` another call is running. `spend_cap` or `budget_cap` a limit stopped it and the work so far is kept. `turn_cap` ran out of turns. `error` the model call failed (the reply says why). `approval_required` a cap was hit and approvals are on for the account; ask the human before approving anything.

Errors come back as `{ error, detail }`. The ones you will meet: `unauthorized`, `rate_limited` (wait `retry_after`), `bad_request` (read `detail`), `bad_model` and `model_key_rejected` (the provider refused; nothing was spent), `payment_required`.

## Your own tools

An agent can call tools you declare. Nothing on Argentic's side calls your systems: each call is recorded and returned in `actions`, and your app carries it out. The agent is told it will not see the result in that run.

Declare them once with `argentic_set_tools`, or send `tools` with a wake (those win for that call). Limits: at most 8 tools, names `[a-z][a-z0-9_]*` up to 40 characters, parameters a flat object schema with string, number, integer, boolean or array properties. Do not reuse a built-in name.

The loop: wake, read `actions`, do them, wake again with what happened.

## Scheduled work

Agents do not wake themselves. Wake with `schedule: true` and the agent may make plans with a wake time. You poll `argentic_due`, and for each agent with something due call `argentic_fire_due`. If you do not poll, leave `schedule` off; the agent is then told not to promise reminders.

## Do not claim

Check https://argentic-labs.vercel.app/docs for the current list. As of this version, there is no streaming, no journal export or replay, and no crash resume. Do not tell the user the platform does those things.
