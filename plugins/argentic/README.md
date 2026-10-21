# Argentic

Argentic runs agents that keep their memory between calls and record what they did. If an agent is cut off in the middle of a run, it picks up where it stopped and does not repeat actions that already finished. Every run comes with a record of what ran, on any model.

This plugin connects your coding agent to Argentic. It does three things and nothing else:

- It adds one MCP server, `https://getargentic.com/mcp`. You sign in with your Argentic account (OAuth) and choose an organization. The plugin never sees your password.
- It adds two skills. `argentic` explains how to build on the API without wasting money or claiming features that do not exist. `argentic-setup` walks through connecting and making a first call.
- It asks, optionally, for a key to your own model provider. If you give one, it is sent as the `X-Model-Key` header on requests to `getargentic.com/mcp`, only so that waking an agent can use your model. Argentic does not store it. Without it, every read and account tool still works.

The plugin runs no local code, installs no packages and has no hooks.

## Tools

Account tools: `get_account`, `get_usage`, `set_budget`, `list_api_keys`, `create_api_key`, `revoke_api_key`.

Agent tools: `argentic_wake`, `argentic_fire_due`, `argentic_resume`, `argentic_wakes`, `argentic_wake_get`, `argentic_journal`, `argentic_replay`, `argentic_memory`, `argentic_due`, `argentic_get_tools`, `argentic_set_tools`, `argentic_usage`, `argentic_approvals`, `argentic_answer_approval`.

`argentic_set_tools` and `argentic_answer_approval` need an owner or admin on the organization.

## Install

Claude Code:

```
claude plugin marketplace add Argentic-Labs-AI/argentic-plugins
claude plugin install argentic@argentic
```

Then run `/mcp` and sign in to `argentic`.

Docs: https://getargentic.com/docs. Privacy: https://getargentic.com/privacy. Terms: https://getargentic.com/terms.

MIT licensed.
