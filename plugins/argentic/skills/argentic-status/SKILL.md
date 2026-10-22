---
name: argentic-status
description: Use when the user asks to see their Argentic agents, what happened, or which runs got cut off ("show me my agents", "what ran today", "did anything stop"). Read-only, spends nothing.
---

# What are my agents doing

This skill only reads. It makes no model call and spends nothing. Do not call `argentic_wake`, `argentic_fire_due` or `argentic_resume` here.

## Steps

1. Find the agents.
   - If the `argentic_agents` tool is available, call it first. It lists each agent with its wake count, open or cut-off count and last wake.
   - If it is not available, ask the user for agent ids, or read them from their code (the `agent` argument to `runDurable`, `run_durable` or `client.wake`). Do not guess ids.
2. For each agent with open wakes, call `argentic_wakes` with `state: "open"`. `interrupted` means the process died. Other states are caps or an error.
3. For one run the user cares about, call `argentic_wake_get` with the wake id. Then read the tail of `argentic_journal` for that agent (the last events, not the whole thing; it comes in pages).
4. If the `get_run_links` tool is available, call it for the runs you list and give the user the dashboard run page and the proof link, if the run is shared. If it is not available, point them at https://getargentic.com/platform and its runs.
5. Present a short table. One row per agent, or per open run if there are few:

   | Agent | Last wake | Open or cut off | State | Where to look |
   |---|---|---|---|---|

   Keep the words plain. Say "cut off" for `interrupted`. Leave out agents with nothing open, and say how many you left out.

## Proof links

Making a run's proof public is a button on the run page in the dashboard. It creates a public page, so the user clicks it themselves. Do not try to do it from here. You can only link to a proof page that already exists.

## If something is open

Say so, and offer `argentic-fix`. Do not resume anything from this skill.

## Do not claim

A clean list means no open wakes were found for the agents you looked at. It does not mean no other agents exist. If `argentic_agents` was not available, say you only checked the ids you were given.
