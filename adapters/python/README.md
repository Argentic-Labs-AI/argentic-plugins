# argentic-labs

Argentic client for Python. Argentic runs your agent's loop: it calls the model, keeps the journal, and hands each tool call back to your code as an action with a stable key. Kill your process mid-run and start it again: it resumes without repeating a finished action, and the run keeps proof of what ran.

The package is the client and `run_durable`, with no dependencies (Python 3.10+), plus three adapters that take the tools you already wrote:

- `argentic_labs.langchain`: LangChain and LangGraph tools. Needs `langchain-core`.
- `argentic_labs.openai_agents`: OpenAI Agents SDK `@function_tool` tools and an `Agent`'s instructions. Needs `openai-agents`. Nothing here runs `Runner`.
- `argentic_labs.pydantic_ai`: Pydantic AI tools (`Tool` objects or plain functions). Needs `pydantic-ai-slim`. Nothing here runs `Agent.run`.

Nothing in this package runs LangChain's, LangGraph's, Pydantic AI's or the Agents SDK's loop. The TypeScript client, `@argentic-labs/client` on npm, does the same job for the Vercel AI SDK and Mastra, and the two read each other's ledger files.

Retry-safe tools for Stripe, Resend, SMTP, Slack, GitHub and a generic HTTP POST are in `argentic_labs.tools` (`tool_pack`), standard library only. See [TOOLS.md](TOOLS.md).

## Install

```
pip install argentic-labs
pip install "argentic-labs[langchain]"      # or [openai-agents], [pydantic-ai]
```

Straight from GitHub, if you want the latest code or a pinned tag (swap `main` for a tag such as `npm-v0.1.4`):

```
pip install "argentic-labs @ git+https://github.com/Argentic-Labs-AI/argentic-plugins@main#subdirectory=adapters/python"
```

You need an Argentic API key from https://getargentic.com/platform and a model key. The default model is a free NVIDIA one; a key is at https://build.nvidia.com. Argentic is free in beta.

## Try it

```
export ARGENTIC_API_KEY=aek_...
export MODEL_KEY=nvapi-...
python -m argentic_labs demo
```

(`argentic-labs demo` does the same.) A support agent refunds an order, emails the customer and closes the ticket. Press Ctrl-C while it works, or pass `--kill-after 1`, then run the same command again: the refund is skipped, the rest finishes, and each wake is checked against the journal. State lives in `./.argentic-demo/`, the same folder the npm demo uses. `--fresh` starts over.

## Use

Plain tools are a name, a JSON schema and a handler:

```python
from argentic_labs import Argentic, Tool, model_from_env, run_durable

def close_ticket(args, ctx):
    # ctx.idempotency_key is "<agent>:<seq>": pass it on to the system you call
    return close(args["ticket_id"], args["note"], idempotency_key=ctx.idempotency_key)

result = run_durable(
    Argentic(),  # reads ARGENTIC_API_KEY and MODEL_KEY
    agent="support-bot", run_id="ticket-77",  # keep both the same across restarts
    task="Close ticket T-77 with the note 'refund sent'.",
    system="Call one tool per turn. When done, reply in one line.",
    tools=[Tool("close_ticket", "Close a support ticket.",
                {"type": "object", "properties": {"ticket_id": {"type": "string"}, "note": {"type": "string"}},
                 "required": ["ticket_id", "note"]}, close_ticket)],
    ledger_path=".argentic-ticket-77.json", model=model_from_env(),
)
print(result.reply)
```

Handlers can be `async def`; `run_durable` itself is synchronous. With LangChain tools:

```python
from langchain_core.tools import tool
from argentic_labs.langchain import from_langchain_tools

@tool
def close_ticket(ticket_id: str, note: str) -> str:
    """Close a support ticket."""
    return f"closed {ticket_id}"

result = run_durable(Argentic(), agent="support-bot", run_id="ticket-77", task="Close ticket T-77.",
                     tools=from_langchain_tools([close_ticket]), ledger_path=".argentic-ticket-77.json")
```

Run it again after a crash and it resumes. `model` defaults to `FREE_MODEL`; `model_from_env()` reads the variables below.

`client.replay(agent, wake_id)` re-renders a wake's prompts from the journal and compares them to what the model was shown. It calls no model and spends nothing. The answer always has `turns`, `matched`, `mismatched` and `unverifiable`, and `summarize_replay(result)` gives one line.

Hooks on `run_durable`: `on_wake_start(step)` just before each wake is sent, `on_wake(step, wake_id, status, replayed)` after each answer, and `on_action(seq, tool, result, fresh)` for every action (`fresh` is False for one the ledger says already finished).

## Waking on a schedule (handle_due)

Beta, and off by default on the hosted API. When an agent falls due (a plan's `wake_at`, a schedule, a timer or a hook event), Argentic POSTs a signed notice to the `wake_url` you registered. The notice names the agent and why it is due and carries no agent content and no model key. `handle_due` checks the signature and the time, then wakes the agent with `fire_due` on your own model key.

The secret (`whsec_...`) is shown once, when you register the `wake_url`. Store it like a password, for example as `ARGENTIC_WEBHOOK_SECRET`. The model key stays on your server: set `MODEL_KEY` there, as for any other wake.

```python
from fastapi import Body, FastAPI, HTTPException, Request
from argentic_labs import WebhookVerificationError, handle_due

app = FastAPI()

@app.post("/argentic/due")
def due(request: Request, body: bytes = Body()):  # the raw bytes, not parsed JSON
    try:
        notice, wake = handle_due(body, request.headers)  # reads ARGENTIC_API_KEY, MODEL_KEY, ARGENTIC_WEBHOOK_SECRET
    except WebhookVerificationError as e:
        raise HTTPException(400 if e.code == "bad_body" else 500 if e.code == "bad_secret" else 401, e.code)
    return {"agent": notice.agent, "wake_id": wake.wake_id}
```

`handle_due(body, headers, secret=..., client=..., model=..., tolerance_seconds=300)` takes the raw body (`bytes` or `str`) and any mapping of headers, looked up without regard to case, so Flask's `request.get_data()` and `request.headers` work too. It returns `(notice, wake)` and raises `WebhookVerificationError` (with a `.code`) before any call is made. `verify_due(body, headers)` only verifies and parses, and returns `(notice, webhook_id)`, so you can queue the notice and wake later. The wake uses the `webhook-id` as its idempotency key, so a notice delivered twice replays the first wake instead of waking twice. Timestamps more than 300 seconds off are refused. A failed wake raises `ArgenticError`; let it return a 5xx so the notice is sent again.

## Settings

| Variable | What it is |
|---|---|
| `ARGENTIC_API_KEY` | Your Argentic API key (`aek_...`). |
| `MODEL_KEY` | Your model provider's key, sent as `X-Model-Key`. Argentic never stores it. |
| `ARGENTIC_BASE_URL` | The API address. Unset, it is `https://api.getargentic.com`. |
| `ARGENTIC_MODEL_ID`, `ARGENTIC_MODEL_PROVIDER`, `ARGENTIC_PRICE_IN`, `ARGENTIC_PRICE_OUT` | A model other than the free default, read by `model_from_env()`. Prices are dollars per million tokens. With no `ARGENTIC_MODEL_ID` you get `FREE_MODEL`. |

`Argentic(api_key=..., model_key=..., base_url=..., timeout=300)` takes the same things as arguments. A 409 (the agent is mid-run) waits and sends the same request again, and a 5xx or a network failure retries with the same key after 1, 2, 4 and 8 seconds, so a retry never adds a message twice. `backoff=` and `max_queued_waits=` change both. If the ledger file is not valid JSON, `run_durable` warns on stderr, sets it aside as `<path>.corrupt` and starts empty, so finished actions may run again. Errors are `ArgenticError` with `.status` (None when no answer came back) and `.body`; `hint_for(error)` returns a next step for the ones a first run tends to hit.

## Honest limits

Delivery is at-least-once. If the process dies while an action is running, before its result is written to the ledger, that action runs again on resume. Make handlers safe to repeat by using `ctx.idempotency_key` (`"<agent>:<seq>"`) with the system you call.

LangChain tools are called the way a LangGraph `ToolNode` calls them, with that key as the tool call id. A tool that takes `tool_call_id: Annotated[str, InjectedToolCallId]` receives `"<agent>:<seq>"` and can pass it on as the idempotency key of the system it calls.

OpenAI Agents SDK tools are called through their own `on_invoke_tool`, with that key as the SDK `ctx.tool_call_id`. Each tool call runs on its own event loop, so call `run_durable` from sync code.

Docs: https://getargentic.com/docs/client/. Source and issues: https://github.com/Argentic-Labs-AI/argentic-plugins.
