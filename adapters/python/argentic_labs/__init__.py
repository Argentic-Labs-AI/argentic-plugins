"""Argentic client and run_durable. Standard library only, Python 3.10+.

Framework adapters live in `argentic_labs.langchain` and `argentic_labs.openai_agents`.
`python -m argentic_labs demo` (or the `argentic-labs` command) kills an agent mid-run and resumes it.
"""
from .core import (
    DEFAULT_BASE_URL,
    FREE_MODEL,
    Action,
    Argentic,
    ArgenticError,
    Ledger,
    ModelSpec,
    RunResult,
    Tool,
    ToolContext,
    WakeResponse,
    __version__,
    hint_for,
    model_from_env,
    run_durable,
    summarize_replay,
    to_argentic_schema,
)

__all__ = [
    "Action", "Argentic", "ArgenticError", "DEFAULT_BASE_URL", "FREE_MODEL", "Ledger", "ModelSpec", "RunResult", "Tool",
    "ToolContext", "WakeResponse", "__version__", "hint_for", "model_from_env", "run_durable", "summarize_replay",
    "to_argentic_schema",
]
