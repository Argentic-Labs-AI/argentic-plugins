# Argentic Python adapters

Argentic runs the agent loop (model calls, memory, journal). These files take the tools you already have and hand them to Argentic. Nothing here runs LangChain's or LangGraph's agent loop.

- `argentic.py`: client plus `run_durable`. Standard library only, Python 3.10+.
- `argentic_langchain.py`: turns LangChain / LangGraph tools into `run_durable` tools. Needs `langchain-core`.
- `argentic_openai_agents.py`: turns OpenAI Agents SDK `@function_tool` tools (and an `Agent`'s instructions) into `run_durable` inputs. Needs `openai-agents`. Nothing here runs `Runner`.

## Install

Copy `argentic.py` (and `argentic_langchain.py` or `argentic_openai_agents.py` for your framework) next to your code.

## Use

```python
from langchain_core.tools import tool
from argentic import Argentic, run_durable, model_from_env
from argentic_langchain import from_langchain_tools

@tool
def close_ticket(ticket_id: str, note: str) -> str:
    """Close a support ticket."""
    return f"closed {ticket_id}"

result = run_durable(
    Argentic(),  # reads ARGENTIC_API_KEY and MODEL_KEY
    agent="support-bot", run_id="ticket-77",  # keep both stable across restarts
    task="Close ticket T-77 with the note 'refund sent'.",
    system="Call one tool per turn. When done, reply in one line.",
    tools=from_langchain_tools([close_ticket]),
    ledger_path=".argentic-ticket-77.json", model=model_from_env(),
)
print(result.reply)
```

Run it again after a crash and it resumes without repeating a finished action. `client.replay(agent, wake_id)` re-checks a wake from the journal and spends nothing.

## Honest limits

This is at-least-once. If the process dies while an action is running, before its result is written to the ledger, that action runs again on resume. Make handlers safe to repeat by using `ctx.idempotency_key` (`"<agent>:<seq>"`) with the system you call.

LangChain tools are called the way a LangGraph `ToolNode` calls them, with that key as the tool call id. A tool that takes `tool_call_id: Annotated[str, InjectedToolCallId]` receives `"<agent>:<seq>"` and can pass it on as the idempotency key of the system it calls.

OpenAI Agents SDK tools are called through their own `on_invoke_tool`, with that key as the SDK `ctx.tool_call_id`. A tool that takes `ctx: ToolContext` can read it and pass it on as the idempotency key of the system it calls. `run_durable` is synchronous, so call it from sync code (each tool call runs on its own event loop).
