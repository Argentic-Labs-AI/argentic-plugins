---
name: argentic-quickstart
description: Use when the user wants to add Argentic to their own project or code ("add Argentic to my project", "set up the client", "run the quickstart"). Picks the client for their stack, puts keys in .env, and makes one small test call.
---

# Add Argentic to a project

This skill puts Argentic into the user's own code. To only connect the MCP, use `argentic-setup` first.

## Keys: read this before anything else

Two keys are involved. The user puts both in place themselves.

- `ARGENTIC_API_KEY` (starts `aek_`): the Argentic key. Get it with the `create_api_key` tool, or from https://getargentic.com/platform.
- `MODEL_KEY`: the user's own key for their model provider. The client sends it as `X-Model-Key`. Argentic does not store it.

Rules:

- Never write a real key into a file you create. Never print one. Never put one in chat.
- If `create_api_key` returns a key, do not repeat it. Tell the user to copy it into `.env` (or their secret store) as `ARGENTIC_API_KEY`, and to add `MODEL_KEY` the same way.
- In files you write, use placeholders such as `ARGENTIC_API_KEY=` with nothing after it.
- If `.gitignore` exists and does not list `.env`, add it. If there is no `.gitignore`, create one with `.env`.

## Steps

1. Check the connection. If the `argentic` MCP is missing, failing, or says `unauthorized`, use `argentic-setup`. Call `get_account` to confirm. It costs nothing. Without the MCP the client still works with an API key, but you cannot create one from here.
2. Detect the stack. Look for `package.json`, `pyproject.toml` or `requirements.txt`. Read the dependencies to find the framework.
3. Pick the client and the matching example. Link the folder, then read it before you write anything:

   | They use | Client | Example |
   |---|---|---|
   | TypeScript, no framework | `npm i @argentic-labs/client` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/core |
   | Vercel AI SDK | `@argentic-labs/client/ai-sdk` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/ai-sdk |
   | Mastra | `@argentic-labs/client/mastra` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/mastra |
   | Python, no framework | `argentic-labs` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/core |
   | LangChain or LangGraph | `argentic_labs.langchain` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/langchain |
   | OpenAI Agents SDK | `argentic_labs.openai_agents` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/openai-agents |
   | Pydantic AI | `argentic_labs.pydantic_ai` | https://github.com/Argentic-Labs-AI/argentic-plugins/tree/main/examples/pydantic-ai |

   The TypeScript client needs Node 22 or newer. The Python client needs 3.10 or newer. The Python package may not be on PyPI yet. If `pip install argentic-labs` fails, use `pip install "argentic-labs @ git+https://github.com/Argentic-Labs-AI/argentic-plugins@main#subdirectory=adapters/python"`.
4. Install the client. Use the project's own package manager.
5. Write the smallest working call. Do not invent names: read the client source for the exact ones. It is in this repo under `adapters/typescript/argentic.ts` and `adapters/python/argentic_labs/core.py`. The names as of client 0.1.6:

   TypeScript:

   ```ts
   import { Argentic, freeModel } from '@argentic-labs/client'

   const client = new Argentic() // reads ARGENTIC_API_KEY and MODEL_KEY
   const res = await client.wake(
     'quickstart-check',
     { message: 'Say hello in one short sentence.', model: freeModel, limits: { max_usd: 0.05 } },
     'quickstart-check-1', // idempotency key
   )
   console.log(res.status, res.reply, res.spent_usd)
   ```

   Python:

   ```python
   from argentic_labs import Argentic, model_from_env

   client = Argentic()  # reads ARGENTIC_API_KEY and MODEL_KEY
   res = client.wake(
       "quickstart-check", "Say hello in one short sentence.",
       model=model_from_env(), idempotency_key="quickstart-check-1",
       limits={"max_usd": 0.05},
   )
   print(res.status, res.reply, res.spent_usd)
   ```

   `freeModel` and `model_from_env()` use a free NVIDIA model. For another model, set `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_MODEL_ID`, `ARGENTIC_PRICE_IN` and `ARGENTIC_PRICE_OUT` (dollars per million tokens), as the examples README describes. Prices matter: the spend limit counts with them.

   Neither client loads `.env` itself. Run the script with the user's usual way of loading it (`node --env-file=.env`, `python-dotenv`, or the shell).
6. If the user already has tools, wire them with `runDurable` (TypeScript) or `run_durable` (Python) and the adapter from the table, as the example does. Keep `agent` and `run_id` the same across restarts.
7. Run it once. Use a throwaway agent id (`quickstart-check`) and `max_usd` of 0.05. The user must have set both keys first. Do not run it before that.
8. Report `spent_usd`, `status` and the agent id you used. If it fails, `hint_for` / `hintFor` in the client turns the error into a plain sentence. `model_key_rejected` and `bad_model` mean nothing was spent.

## Side effects in the user's own tools

When the agent calls a tool of the user's, Argentic hands the call back to their code as an action. Every action carries a stable key, so a cut-off one can be retried safely. In the client it is `ctx.idempotency_key` (Python) or `ctx.idempotencyKey` (TypeScript), shaped `agent:seq`. Tell the user to pass it on to the system they call (a payment, an email, a ticket) so a repeat is recorded once. Do not promise more than that.

## When done

Say what you added, which files changed, and that the keys are still the user's to place. Point to `argentic-status` to look at the run and `argentic-fix` if one stops.
