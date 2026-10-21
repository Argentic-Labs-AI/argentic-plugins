# OpenAI plugin directory package

The public ChatGPT and Codex directory takes a ZIP with a root `plugin.json` and `mcp.json`. This folder holds those two files. The ZIP also needs `skills/` (copied from `plugins/argentic/skills/`) and `assets/logo.png` (copied from `plugins/argentic/assets/logo.png`).

Differences from the Claude Code plugin, on purpose:

- No `headers`. The public portal rejects them, so the `X-Model-Key` header is left out and waking an agent from this listing needs another way to give it a model key. Read and account tools work.
- Sign-in uses a Client ID Metadata Document (`cimd`), which the Argentic auth server supports. It has no dynamic client registration endpoint.
- No hooks and no app references, which the portal refuses.

Build the ZIP from the repository root:

```
mkdir -p /tmp/argentic-openai/assets && cp directory/openai/plugin.json directory/openai/mcp.json /tmp/argentic-openai/ && cp -r plugins/argentic/skills /tmp/argentic-openai/ && cp plugins/argentic/assets/logo.png /tmp/argentic-openai/assets/ && (cd /tmp/argentic-openai && zip -r ../argentic-openai.zip .)
```
