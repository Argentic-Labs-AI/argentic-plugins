# Argentic plugins

Connect your coding agent to [Argentic](https://getargentic.com/docs): wake agents that keep their memory between calls, read what they remember, give them tools, and manage your API keys, usage and budget.

This repo holds only manifests, skills, MCP settings and small client adapters. The engine is not in it.

There is one MCP, `https://getargentic.com/mcp`. You sign in with your Argentic account (OAuth) and pick an organization. No API key is needed for the MCP. To wake an agent you also need your own key for a model provider; it travels in the `X-Model-Key` header on each request and Argentic never stores it.

## Kill it mid-run (2 minutes)

You need an Argentic API key from https://getargentic.com/platform and a model key. The default model is a free NVIDIA one; get its key at https://build.nvidia.com. Node 22 or newer.

```
export ARGENTIC_API_KEY=aek_...
export MODEL_KEY=nvapi-...
npx @argentic-labs/client demo
```

fish:

```
set -x ARGENTIC_API_KEY aek_...
set -x MODEL_KEY nvapi-...
npx @argentic-labs/client demo
```

A small support agent refunds an order, emails the customer and closes the ticket, one action every couple of seconds. Press Ctrl-C while it works, then run the same command again from the same folder. The rerun skips the actions that already finished and does the rest. An action you cut off halfway runs again, which is safe because every action carries a stable key. At the end the demo counts what landed in its outbox (one line per action), checks every wake against the journal, and tells you where the run is in the dashboard. Open the run you killed and press Check prompts under Proof of what ran.

`--fresh` starts a new run. `--kill-after 1` kills it for you if you'd rather not race the keyboard. The source is [`adapters/typescript/cli.ts`](adapters/typescript/cli.ts).

## Crash-test any agent (5 minutes)

[`crash-test/`](crash-test/) is a small open tool that kills an agent at each tool call, restarts it, and reports which actions ran twice. It works on agents built on any framework, with or without Argentic, and needs no keys. Start with the [quickstart](crash-test/README.md#quickstart-5-minutes).

## Claude Code

```
claude plugin marketplace add Argentic-Labs-AI/argentic-plugins
claude plugin install argentic@argentic
```

Claude Code asks for your model key (optional, only needed to wake agents) and stores it securely. Then run `/mcp` and sign in to `argentic`.

MCP only, no plugin:

```
claude mcp add --transport http --header "X-Model-Key: $MODEL_KEY" argentic https://getargentic.com/mcp
```

Then run `/mcp` to sign in.

## claude.ai and Claude Projects

Customize, Connectors, Add custom connector, URL `https://getargentic.com/mcp`. Under Request headers add `x-api-key` with your model key (only needed to wake agents). Claude only sends header names Anthropic has approved, and `X-Model-Key` is not one, so use `x-api-key`: Argentic reads it as the model key. Request headers is a beta that not every account has yet; if you don't see it, the connector still signs in and reads, and you wake agents from Claude Code or Codex. Sign in and pick your organization. Disconnect any time in your Argentic settings.

For the skills: Customize, Plugins, the + next to Personal plugins, Add marketplace, From a repository, `Argentic-Labs-AI/argentic-plugins`.

## Cursor

Once the listing is live, search for Argentic in the Cursor marketplace. Until then, add the MCP by hand in `~/.cursor/mcp.json`:

```
{"mcpServers": {"argentic": {"url": "https://getargentic.com/mcp"}}}
```

Cursor opens the sign-in when you enable the server.

## Codex

```
codex plugin marketplace add Argentic-Labs-AI/argentic-plugins
```

That adds the skills. Add the MCP to `~/.codex/config.toml`:

```
[mcp_servers.argentic]
url = "https://getargentic.com/mcp"
env_http_headers = { "X-Model-Key" = "MODEL_KEY" }
```

Export `MODEL_KEY` where Codex starts, then sign in with `codex mcp login argentic`.

## Without the MCP

The HTTP API still works on its own: `POST /v1/agents/{agent}/wake` and the other routes take an API key (`aek_...`, created by the `create_api_key` tool or in the dashboard) as `Authorization: Bearer`, plus `X-Model-Key` to wake. See the [docs](https://getargentic.com/docs).

## Bring your own framework

Already have tools written for the Vercel AI SDK, Mastra, LangChain / LangGraph, Pydantic AI or the OpenAI Agents SDK? Hand the loop to Argentic and keep the tools. [`adapters/`](adapters/) has one small adapter per framework (TypeScript: `npm i @argentic-labs/client`; Python: `argentic-labs`, coming to PyPI, until then `pip install` it from this repo as [`adapters/python`](adapters/python/README.md) describes), and [`examples/`](examples/) has a runnable refund agent for each, plus one with no framework at all. Kill it mid-run and it resumes without repeating a finished action. Both clients also ship the same demo to try it with nothing to write: `npx @argentic-labs/client demo` or `python -m argentic_labs demo`.

## Ask your agent to do it

```
Set up Argentic for me. Read https://getargentic.com/docs/agents and follow it for the tool I'm using right now. Don't ask me to paste keys into this chat: tell me where each key goes and let me put it there. When it's connected, call get_account and tell me what it returned.
```

## What is in the plugin

- `argentic` skill: how to build on the API without wasting money or claiming features that do not exist.
- `argentic-setup` skill: connect, and make a first call for a few cents at most.
- `argentic-quickstart` skill: add Argentic to your own project, with keys in `.env`, and run one small test call.
- `argentic-status` skill: list your agents and which runs got cut off. Read only.
- `argentic-fix` skill: find why a run stopped, then resume it or ask you to approve.
- `argentic` MCP server, signed in with your Argentic account.
  - Account tools: `get_account`, `list_api_keys`, `create_api_key`, `revoke_api_key`, `get_usage`, `set_budget`.
  - Agent tools: `argentic_wake`, `argentic_fire_due`, `argentic_resume`, `argentic_wakes`, `argentic_wake_get`, `argentic_journal`, `argentic_replay`, `argentic_memory`, `argentic_due`, `argentic_get_tools`, `argentic_set_tools`, `argentic_approvals`, `argentic_answer_approval`.
  - `argentic_set_tools` and `argentic_answer_approval` need an owner or admin. Other tools work as far as your role allows.

MIT licensed.
