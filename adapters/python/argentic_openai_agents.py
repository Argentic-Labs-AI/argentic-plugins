"""Use OpenAI Agents SDK tools with Argentic.

Only the tool definitions and the instructions are used. Argentic runs the agent
loop, not `Runner`.
"""
from __future__ import annotations

import json
from typing import Any, Iterable

from agents import FunctionTool
from agents.tool_context import ToolContext as SdkToolContext

from argentic import Tool


def from_openai_agents_tools(tools: Iterable[Any]) -> list[Tool]:
    """Turn @function_tool / FunctionTool objects into run_durable tools (Argentic accepts up to 8)."""
    out: list[Tool] = []
    for t in tools:
        if not isinstance(t, FunctionTool):
            raise TypeError(f"{getattr(t, 'name', t)!r} is not a FunctionTool; only function tools carry over")
        out.append(Tool(
            name=t.name,
            description=t.description or "",
            parameters=t.params_json_schema or {"type": "object", "properties": {}},
            # bind t as a default so each tool keeps its own handler
            execute=lambda args, ctx, t=t: _invoke(t, args, ctx),
        ))
    return out


async def _call(t: FunctionTool, args: dict, key: str) -> Any:
    raw = json.dumps(args)
    # The action's idempotency key is the tool call id, so a handler that reads
    # `ctx.tool_call_id` can use it to stay safe to repeat.
    sdk_ctx = SdkToolContext(context=None, tool_name=t.name, tool_call_id=key, tool_arguments=raw)
    return await t.on_invoke_tool(sdk_ctx, raw)


def _invoke(t: FunctionTool, args: dict, ctx: Any) -> Any:
    import asyncio
    return asyncio.run(_call(t, args, ctx.idempotency_key))


def instructions(agent_or_text: Any) -> str | None:
    """Accept an Agent (its instructions) or a plain string for the system prompt."""
    if agent_or_text is None or isinstance(agent_or_text, str):
        return agent_or_text
    text = getattr(agent_or_text, "instructions", None)
    if isinstance(text, str):
        return text
    raise TypeError("instructions must be a string, or an Agent whose instructions is a string")
