---
name: argentic-fix
description: Use when an Argentic run stopped or the user asks why ("why did my run stop", "resume it", "approve it", "it hit a cap"). Finds the cause from the wake and journal, proposes a fix, resumes only after the user says yes.
---

# Fix a run that stopped

Resuming a run spends money on the user's model key. Find the cause first, say it, and wait for a yes before you resume.

## Steps

1. Get the wake. If you do not have the wake id, call `argentic_wakes` with `state: "open"` for the agent. Then call `argentic_wake_get` and read its `status`.
2. Read the journal. Call `argentic_journal` for that agent with `wake` set to the wake id, and look at the last 20 or so events. The kinds are `trigger`, `turn_started`, `model_reply`, `tool_call` and `tool_result`; pass `kind: "tool_call,tool_result"` to see only the tool steps, and `bodies: true` when you need what a tool returned.
3. State the cause in one sentence, with the evidence. Example: "The run stopped on `spend_cap`: it had spent $0.05 of a $0.05 limit after 6 turns."
4. Propose the fix from the table below.
5. Resume only after the user says yes. Use `argentic_resume`. It needs the model key on the connection.

## Status, meaning, fix

| State | What it means | What to do |
|---|---|---|
| `interrupted` | The process died mid-run. | Resume. |
| `queued` | Another call holds the agent. | Wait `retry_after` seconds and send again. A run that died holds the agent for up to two minutes. |
| `spend_cap` or `budget_cap` | A spend limit stopped it. Work so far is kept. | Ask the user. If they agree, resume with a higher `max_usd`. For the organization budget, `set_budget` needs an owner or admin. |
| `turn_cap` | It ran out of turns. | Resume with a higher `max_turns`. |
| `time_cap` | It ran out of time. | Resume. It continues. |
| `error`, `bad_model`, `model_key_rejected` | The model call failed or the provider refused. Nothing was spent. | Fix the model id or the key, then resume. The reply says why. |
| `model_key_required` | The model key header is missing. | Use `argentic-setup`. The user adds the key to the connection. |
| `approval_required` | A cap was hit and approvals are on for the account. | List them with `argentic_approvals`. Ask the human. |

## Approvals

Never approve on your own. `argentic_answer_approval` lets an agent spend more. Show the user what is waiting (the agent, the amount, why), ask, and answer only with what they said. It needs an owner or admin.

## What resume does

Anything you send, such as a higher `max_usd`, replaces what the wake had. A tool call that already finished is not run again. A tool call that was cut off is requested again once, so de-duplicate on the action's stable `seq` (the key is `agent:seq`). A model call that was lost is asked again and charged at its estimate. Resume does not add the original message a second time.

## After

Tell the user the new status and what it spent (`spent_usd`). If it stopped again, go back to step 1 with the new wake. Do not loop on resume by yourself.
