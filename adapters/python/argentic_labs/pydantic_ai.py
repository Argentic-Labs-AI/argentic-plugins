"""Use Pydantic AI tools with Argentic.

Only the tool definitions are used. Argentic runs the agent loop, not `Agent.run`.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Iterable

from pydantic_ai import RunContext, Tool
from pydantic_ai.models.test import TestModel
from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai.usage import RunUsage
from pydantic_core import to_jsonable_python

from .core import Tool as ArgenticTool


def from_pydantic_ai_tools(tools: Iterable[Tool | Callable[..., Any]]) -> list[ArgenticTool]:
    """Turn Pydantic AI tools (`Tool` objects, or plain functions) into run_durable tools (Argentic accepts up to 8)."""
    toolset = FunctionToolset([t if isinstance(t, Tool) else Tool(t) for t in tools])
    defs = asyncio.run(_defs(toolset))
    return [
        ArgenticTool(
            name=name,
            description=d.description or "",
            parameters=d.parameters_json_schema or {"type": "object", "properties": {}},
            # bind name as a default so each tool keeps its own handler
            execute=lambda args, ctx, name=name: asyncio.run(_call(toolset, name, args, ctx.idempotency_key)),
        )
        for name, d in defs.items()
    ]


def _context(key: str, name: str | None = None) -> RunContext[None]:
    # The action's idempotency key is the tool call id, so a handler that reads
    # `ctx.tool_call_id` can use it to stay safe to repeat. Argentic runs the loop,
    # so there is no model here for the handler to call.
    return RunContext(deps=None, model=TestModel(), usage=RunUsage(), tool_call_id=key, tool_name=name)


async def _defs(toolset: FunctionToolset[None]) -> dict[str, Any]:
    return {name: t.tool_def for name, t in (await toolset.get_tools(_context(""))).items()}


async def _call(toolset: FunctionToolset[None], name: str, args: dict, key: str) -> Any:
    ctx = _context(key, name)
    tool = (await toolset.get_tools(ctx))[name]
    # Validate the way an Agent would: coerces types, raises on a missing or wrong argument.
    valid = tool.args_validator.validate_python(args)
    return to_jsonable_python(await toolset.call_tool(name, valid, ctx, tool))


def instructions(agent_or_text: Any) -> str | None:
    """Accept a plain string for the system prompt, or an object whose `instructions` is a string."""
    if agent_or_text is None or isinstance(agent_or_text, str):
        return agent_or_text
    text = getattr(agent_or_text, "instructions", None)
    if isinstance(text, str):
        return text
    raise TypeError("instructions must be a string, or an object whose instructions is a string")
