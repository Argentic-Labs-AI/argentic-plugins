# Argentic plugins

Connect your coding agent to the [Argentic Engine API](https://argentic-labs.vercel.app/docs): wake agents that keep their memory between calls, read what they remember, give them tools, and cap what they spend.

This repo holds only manifests, skills and MCP settings. The engine is not in it.

You need an Argentic API key (starts with `aek_`, issued by Argentic Labs). To wake an agent you also need your own key for a model provider; Argentic never stores it.

## Claude Code

```
claude plugin marketplace add organisely/argentic-plugins
claude plugin install argentic@argentic
```

Claude Code asks for your Argentic API key and, if you want to wake agents, your model key. They go in secure storage. No API key yet? Leave it empty, run `/mcp`, sign in to `argentic-platform`, and ask Claude to create one.

MCP only, no plugin:

```
claude mcp add --transport http argentic https://br-proud-morning-b7usdmsq-engine.compute.c-13.us-east-1.aws.neon.tech/mcp \
  --header "Authorization: Bearer $ARGENTIC_API_KEY" --header "X-Model-Key: $MODEL_KEY"
```

Account tools only (API keys, usage, budget), signed in with your Argentic account:

```
claude mcp add --transport http argentic-platform https://argentic-labs.vercel.app/mcp
```

## claude.ai and Claude Projects

To manage your account from Claude: Customize, Connectors, Add custom connector, URL `https://argentic-labs.vercel.app/mcp`. Sign in and pick the organization Claude may manage. Disconnect it any time in your Argentic settings.

For the skills: Customize, Plugins, the + next to Personal plugins, Add marketplace, From a repository, `organisely/argentic-plugins`.

This installs the skills. The engine tools need a connector with a fixed key, and the Request headers option for that is a beta that not every account has. If you do not see it, use Claude Code or Codex for the engine tools.

## Codex

```
codex plugin marketplace add organisely/argentic-plugins
```

That adds the skills. Add the MCP server to `~/.codex/config.toml`:

```
[mcp_servers.argentic]
url = "https://br-proud-morning-b7usdmsq-engine.compute.c-13.us-east-1.aws.neon.tech/mcp"
bearer_token_env_var = "ARGENTIC_API_KEY"
env_http_headers = { "X-Model-Key" = "MODEL_KEY" }
```

Then export `ARGENTIC_API_KEY` and `MODEL_KEY` where Codex starts.

## Ask your agent to do it

Paste this into any coding agent:

```
Set up Argentic for me. Read https://argentic-labs.vercel.app/docs/agents and follow it for the tool I'm using right now. Don't ask me to paste keys into this chat: tell me where each key goes and let me put it there. When it's connected, call argentic_usage and tell me what it returned.
```

## What is in the plugin

- `argentic` skill: how to build on the API without wasting money or claiming features that do not exist.
- `argentic-setup` skill: connect, and make a first call for a few cents at most.
- `argentic-platform` MCP server, signed in with your Argentic account: `get_account`, `list_api_keys`, `create_api_key`, `revoke_api_key`, `get_usage`, `set_budget`. Each works only as far as your role in the organization allows.
- `argentic` MCP server entry with these tools: `argentic_wake`, `argentic_fire_due`, `argentic_resume`, `argentic_wakes`, `argentic_wake_get`, `argentic_journal`, `argentic_replay`, `argentic_memory`, `argentic_due`, `argentic_get_tools`, `argentic_set_tools`, `argentic_usage`, `argentic_billing`, `argentic_billing_checkout`, `argentic_approvals`, `argentic_answer_approval`.

MIT licensed.
