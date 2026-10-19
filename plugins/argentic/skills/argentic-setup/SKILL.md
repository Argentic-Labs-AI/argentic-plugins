---
name: argentic-setup
description: Use when the user wants to connect to Argentic, the argentic MCP server is missing, failing or returning unauthorized or model_key_required, or they want to make a first safe test call.
---

# Connecting to Argentic

## What you need

1. An Argentic API key (starts with `aek_`). Argentic Labs issues these; if the user has none, they ask Argentic Labs for one. Do not invent one.
2. For waking agents only: the user's own key for a model provider (OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, Groq, Together, Fireworks, Mistral, xAI or NVIDIA, or any OpenAI-compatible https endpoint). Reading memory, usage and the other free tools does not need it.

Never ask the user to paste a key into the chat. Point them at the place the key goes and let them put it there.

## Where the keys go

- Claude Code plugin: `claude plugin marketplace add organisely/argentic-plugins`, then `claude plugin install argentic@argentic`. Claude Code asks for the keys when the plugin is enabled. Change them in `/plugin`.
- Claude Code, MCP only: `claude mcp add --transport http argentic <API URL>/mcp --header "Authorization: Bearer $ARGENTIC_API_KEY" --header "X-Model-Key: $MODEL_KEY"` with both variables set in the shell first.
- Codex: in `~/.codex/config.toml`, a `[mcp_servers.argentic]` table with `url`, `bearer_token_env_var = "ARGENTIC_API_KEY"` and `env_http_headers = { "X-Model-Key" = "MODEL_KEY" }`, with both variables exported.
- claude.ai custom connector: Customize, Connectors, Add custom connector, with the MCP URL. A fixed bearer key goes under Request headers, which is a beta that not every account has yet; if the section is missing, use Claude Code or Codex instead.

The MCP URL is the API address plus `/mcp`.

## Check it works, cheaply

1. Call `argentic_usage`. It costs nothing and proves the Argentic API key. `unauthorized` means the key is wrong or revoked.
2. Call `argentic_memory` for any agent id. Empty is fine; it proves the agent routes work.
3. Only then wake: `argentic_wake` with a throwaway agent id like `setup-check`, a short message, the user's model id and prices, and `max_usd` of 0.05. A `model_key_rejected` or `bad_model` answer means the provider refused it and nothing was spent.

Tell the user what the call cost (`spent_usd`) and which agent id you used.
