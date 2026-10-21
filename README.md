# Argentic plugins

Connect your coding agent to [Argentic](https://argentic-labs.vercel.app/docs): wake agents that keep their memory between calls, read what they remember, give them tools, and manage your API keys, usage and budget.

This repo holds only manifests, skills, MCP settings and small client adapters. The engine is not in it.

There is one MCP, `https://argentic-labs.vercel.app/mcp`. You sign in with your Argentic account (OAuth) and pick an organization. No API key is needed for the MCP. To wake an agent you also need your own key for a model provider; it travels in the `X-Model-Key` header on each request and Argentic never stores it.

## Claude Code

```
claude plugin marketplace add Argentic-Labs-AI/argentic-plugins
claude plugin install argentic@argentic
```

Claude Code asks for your model key (optional, only needed to wake agents) and stores it securely. Then run `/mcp` and sign in to `argentic`.

MCP only, no plugin:

```
claude mcp add --transport http --header "X-Model-Key: $MODEL_KEY" argentic https://argentic-labs.vercel.app/mcp
```

Then run `/mcp` to sign in.

## claude.ai and Claude Projects

Customize, Connectors, Add custom connector, URL `https://argentic-labs.vercel.app/mcp`. Under Request headers add `x-api-key` with your model key (only needed to wake agents). Claude only sends header names Anthropic has approved, and `X-Model-Key` is not one, so use `x-api-key`: Argentic reads it as the model key. Request headers is a beta that not every account has yet; if you don't see it, the connector still signs in and reads, and you wake agents from Claude Code or Codex. Sign in and pick your organization. Disconnect any time in your Argentic settings.

For the skills: Customize, Plugins, the + next to Personal plugins, Add marketplace, From a repository, `Argentic-Labs-AI/argentic-plugins`.

## Codex

```
codex plugin marketplace add Argentic-Labs-AI/argentic-plugins
```

That adds the skills. Add the MCP to `~/.codex/config.toml`:

```
[mcp_servers.argentic]
url = "https://argentic-labs.vercel.app/mcp"
env_http_headers = { "X-Model-Key" = "MODEL_KEY" }
```

Export `MODEL_KEY` where Codex starts, then sign in with `codex mcp login argentic`.

## Without the MCP

The HTTP API still works on its own: `POST /v1/agents/{agent}/wake` and the other routes take an API key (`aek_...`, created by the `create_api_key` tool or in the dashboard) as `Authorization: Bearer`, plus `X-Model-Key` to wake. See the [docs](https://argentic-labs.vercel.app/docs).

## Bring your own framework

Already have tools written for the Vercel AI SDK, Mastra, LangChain / LangGraph or the OpenAI Agents SDK? Hand the loop to Argentic and keep the tools. [`adapters/`](adapters/) has one small adapter per framework (TypeScript: `npm i @argentic-labs/client`; Python is coming to PyPI as `argentic-labs`, until then copy it from this repo), and [`examples/`](examples/) has a runnable refund agent for each, plus one with no framework at all. Kill it mid-run and it resumes without repeating a finished action.

## Ask your agent to do it

```
Set up Argentic for me. Read https://argentic-labs.vercel.app/docs/agents and follow it for the tool I'm using right now. Don't ask me to paste keys into this chat: tell me where each key goes and let me put it there. When it's connected, call get_account and tell me what it returned.
```

## What is in the plugin

- `argentic` skill: how to build on the API without wasting money or claiming features that do not exist.
- `argentic-setup` skill: connect, and make a first call for a few cents at most.
- `argentic` MCP server, signed in with your Argentic account.
  - Account tools: `get_account`, `list_api_keys`, `create_api_key`, `revoke_api_key`, `get_usage`, `set_budget`.
  - Agent tools: `argentic_wake`, `argentic_fire_due`, `argentic_resume`, `argentic_wakes`, `argentic_wake_get`, `argentic_journal`, `argentic_replay`, `argentic_memory`, `argentic_due`, `argentic_get_tools`, `argentic_set_tools`, `argentic_approvals`, `argentic_answer_approval`.
  - `argentic_set_tools` and `argentic_answer_approval` need an owner or admin. Other tools work as far as your role allows.

MIT licensed.
