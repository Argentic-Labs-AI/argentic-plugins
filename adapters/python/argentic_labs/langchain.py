"""Use LangChain / LangGraph tools with Argentic.

Only the tool definitions are used. Argentic runs the agent loop, not
LangChain or LangGraph.
"""
from __future__ import annotations

import json
from typing import Any, Iterable

from langchain_core.utils.function_calling import convert_to_openai_tool

from .core import Tool


def from_langchain_tools(tools: Iterable[Any]) -> list[Tool]:
    """Turn BaseTool / @tool objects into run_durable tools (Argentic accepts up to 8)."""
    out: list[Tool] = []
    for t in tools:
        fn = convert_to_openai_tool(t)["function"]
        out.append(Tool(
            name=fn["name"],
            description=fn.get("description", ""),
            parameters=fn.get("parameters") or {"type": "object", "properties": {}},
            # bind t as a default so each tool keeps its own handler
            execute=lambda args, ctx, t=t: _invoke(t, args, ctx),
        ))
    return out


def _invoke(t: Any, args: dict, ctx: Any) -> Any:
    """Call a tool the way a LangGraph ToolNode would, with the action's
    idempotency key as the tool call id, so a handler that takes
    `Annotated[str, InjectedToolCallId]` can use it to stay safe to repeat."""
    msg = t.invoke({"type": "tool_call", "id": ctx.idempotency_key, "name": t.name, "args": args})
    content = getattr(msg, "content", msg)
    if isinstance(content, str):
        try:
            return json.loads(content)
        except ValueError:
            return content
    return content


def system_prompt(prompt: Any) -> str | None:
    """Accept a LangGraph-style system prompt: a string or a SystemMessage."""
    if prompt is None or isinstance(prompt, str):
        return prompt
    content = getattr(prompt, "content", None)
    if isinstance(content, str):
        return content
    raise TypeError("system prompt must be a string or a SystemMessage")
