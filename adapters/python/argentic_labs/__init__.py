"""Argentic client and run_durable. Standard library only, Python 3.10+.

Framework adapters live in `argentic_labs.langchain` and `argentic_labs.openai_agents`.
Retry-safe tools for Stripe, Resend, SMTP, Slack, GitHub and HTTP: `argentic_labs.tools.tool_pack`.
"""
from .core import (
    Argentic,
    ArgenticError,
    Ledger,
    RetryLater,
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
    "Argentic", "ArgenticError", "Ledger", "RetryLater", "RunResult", "Tool", "ToolContext",
    "WakeResponse", "hint_for", "model_from_env", "run_durable", "summarize_replay", "to_argentic_schema",
]
__version__ = "0.1.0"
