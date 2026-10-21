# Examples

Argentic runs your agent's loop. You keep your framework's tool definitions and system prompt; Argentic calls the model, keeps the journal and hands each tool call back to your code as an action with a stable `seq`. Kill your agent mid-action and it resumes without repeating a finished action, and every run comes with proof of what ran.

| Example | Framework | Language |
|---|---|---|
| [core](core/) | None: plain tools with a JSON schema | TypeScript |
| [ai-sdk](ai-sdk/) | Vercel AI SDK `tool()` | TypeScript |
| [langchain](langchain/) | LangChain / LangGraph `@tool` | Python |
| [openai-agents](openai-agents/) | OpenAI Agents SDK `@function_tool` | Python |
| [mastra](mastra/) | Mastra `createTool()` | TypeScript |

All five tell the same story: refund an order, email the customer, close the ticket. The first run kills itself right after the refund. The second run skips the refund, finishes the rest and checks each wake against the journal. Then you open the run timeline in the dashboard and press **Check** under **Proof of what ran**.

Want a web app instead of a script? [templates/support-agent](../templates/support-agent/) is a deployable Next.js support agent on the AI SDK with a Kill button, a sandbox inbox and a proof check.

Just want to see it? `npx @argentic-labs/client demo` runs the same story with nothing to clone (see the [repo README](../README.md#kill-it-mid-run-2-minutes)). No framework? Start with [core](core/). The core files in [`../adapters`](../adapters/) work on their own: `runDurable` (TypeScript) and `run_durable` (Python) take plain tools with a JSON schema and a handler.

You need an Argentic API key from https://getargentic.com/platform and a model key. The default model is a free NVIDIA NIM model (get a key at https://build.nvidia.com); set `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN` and `ARGENTIC_PRICE_OUT` to use another.

## Settings

Each example reads these from the environment:

| Variable | Needed | What it is |
|---|---|---|
| `ARGENTIC_API_KEY` | yes | Your Argentic API key (`aek_...`). The docs call the same key `AEK_KEY`. |
| `MODEL_KEY` | yes | Your model provider's key, sent as `X-Model-Key`. Argentic never stores it. |
| `ARGENTIC_CRASH_AFTER` | no | Kill the process after this many actions, to try a crash. |
| `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN`, `ARGENTIC_PRICE_OUT` | no | Use a model other than the free NVIDIA default. Prices are dollars per million tokens. |
| `ARGENTIC_BASE_URL` | no | The API address. Leave it unset to use the production API. |
| `ARGENTIC_DASHBOARD_URL` | no | Where the final "open the run timeline" line points. |

If a run stops with `provider_rate_limited`, the free NVIDIA tier is busy. Wait half a minute and run the same command again: it picks up where it stopped.
