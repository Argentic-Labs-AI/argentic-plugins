"""Argentic client and run_durable. Standard library only, Python 3.10+.

Framework adapters live in `argentic_labs.langchain` and `argentic_labs.openai_agents`.
"""
from .core import (
    Argentic,
    ArgenticError,
    Ledger,
    RunResult,
    Tool,
    ToolContext,
    WakeResponse,
    hint_for,
    model_from_env,
    run_durable,
    summarize_replay,
    to_argentic_schema,
)

__all__ = [
    "Argentic", "ArgenticError", "Ledger", "RunResult", "Tool", "ToolContext",
    "WakeResponse", "hint_for", "model_from_env", "run_durable", "summarize_replay", "to_argentic_schema",
]
__version__ = "0.1.0"
