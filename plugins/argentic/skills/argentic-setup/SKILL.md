---
name: argentic-setup
description: Use when the user wants to connect to Argentic, the argentic MCP server is missing, failing or returning unauthorized or model_key_required, or they want to make a first safe test call.
---

# Connecting to Argentic

## What you need

1. An Argentic account. The MCP signs in with it (OAuth) and asks which organization to use. No API key is needed.
2. For waking agents only: the user's own key for a model provider (OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, Groq, Together, Fireworks, Mistral, xAI or NVIDIA, or any OpenAI-compatible https endpoint). Reading memory, usage and the other tools does not need it.

Never ask the user to paste a key into the chat. Point them at the place the key goes and let them put it there. The model key goes in the `X-Model-Key` header, never in a tool argument.

## Where to connect

The one MCP is `https://argentic-labs.vercel.app/mcp`.

- Claude Code plugin: `claude plugin marketplace add organisely/argentic-plugins`, then `claude plugin install argentic@argentic`. Claude Code asks for the optional model key. Then `/mcp` and sign in to `argentic`.
- Claude Code, MCP only: `claude mcp add --transport http --header "X-Model-Key: $MODEL_KEY" argentic https://argentic-labs.vercel.app/mcp` with `MODEL_KEY` set in the shell first, then `/mcp` to sign in.
- claude.ai: Customize, Connectors, Add custom connector, the URL above. Under Request headers add `X-Model-Key` with the model key (only needed to wake agents). Sign in and pick the organization.
- Codex: in `~/.codex/config.toml`, a `[mcp_servers.argentic]` table with the `url` above and `env_http_headers = { "X-Model-Key" = "MODEL_KEY" }`, with `MODEL_KEY` exported. Sign in with `codex mcp login argentic`.

Without the MCP, the HTTP API takes an API key (`aek_...`, from the `create_api_key` tool or the dashboard) plus `X-Model-Key`.

## Check it works, cheaply

1. Call `get_account`. It costs nothing and proves the sign-in and organization. `unauthorized` means sign in again via `/mcp`.
2. Call `argentic_memory` for any agent id. Empty is fine; it proves the agent routes work.
3. Only then wake: `argentic_wake` with a throwaway agent id like `setup-check`, a short message, the user's model id and prices, and `max_usd` of 0.05. A `model_key_rejected` or `bad_model` answer means the provider refused it and nothing was spent. `model_key_required` means the header is not set.

Tell the user what the call cost (`spent_usd`) and which agent id you used.
