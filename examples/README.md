# Examples

Argentic runs your agent's loop. You keep your framework's tool definitions and system prompt; Argentic calls the model, keeps the journal and hands each tool call back to your code as an action with a stable `seq`. Kill your agent mid-action and it resumes without repeating a finished action, and every run comes with proof of what ran.

| Example | Framework | Language |
|---|---|---|
| [ai-sdk](ai-sdk/) | Vercel AI SDK `tool()` | TypeScript |
| [langchain](langchain/) | LangChain / LangGraph `@tool` | Python |

Both tell the same story: refund an order, email the customer, close the ticket. The first run kills itself right after the refund. The second run skips the refund, finishes the rest and checks each wake against the journal. Then you open the run timeline and press **Verify this run**.

No framework? The core files in [`../adapters`](../adapters/) work on their own: `runDurable` (TypeScript) and `run_durable` (Python) take plain tools with a JSON schema and a handler.

You need an Argentic API key from https://argentic-labs.vercel.app/platform and a model key. The default model is a free NVIDIA NIM model (get a key at https://build.nvidia.com); set `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN` and `ARGENTIC_PRICE_OUT` to use another.
