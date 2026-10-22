"""Argentic client and run_durable. Standard library only, Python 3.10+.

Framework adapters live in `argentic_labs.langchain`, `argentic_labs.openai_agents` and `argentic_labs.pydantic_ai`.
`python -m argentic_labs demo` (or the `argentic-labs` command) kills an agent mid-run and resumes it.
Retry-safe tools for Stripe, Resend, SMTP, Slack, GitHub and HTTP: `argentic_labs.tools.tool_pack`.
"""
from .core import (
    DEFAULT_BASE_URL,
    FREE_MODEL,
    Action,
    Argentic,
    ArgenticError,
    Ledger,
    ModelSpec,
    RetryLater,
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
    "Action", "Argentic", "ArgenticError", "DEFAULT_BASE_URL", "FREE_MODEL", "Ledger", "ModelSpec", "RetryLater", "RunResult", "Tool",
    "ToolContext", "WakeResponse", "__version__", "hint_for", "model_from_env", "run_durable", "summarize_replay",
    "to_argentic_schema",
]
