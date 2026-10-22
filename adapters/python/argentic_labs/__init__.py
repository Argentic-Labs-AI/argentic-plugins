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
    DueNotice,
    ToolContext,
    WakeResponse,
    WebhookVerificationError,
    __version__,
    handle_due,
    hint_for,
    model_from_env,
    run_durable,
    sign_notice,
    summarize_replay,
    to_argentic_schema,
    verify_due,
)

__all__ = [
    "Action", "Argentic", "ArgenticError", "DEFAULT_BASE_URL", "DueNotice", "FREE_MODEL", "Ledger", "ModelSpec", "RetryLater", "RunResult",
    "Tool", "ToolContext", "WakeResponse", "WebhookVerificationError", "__version__", "handle_due", "hint_for", "model_from_env",
    "run_durable", "sign_notice", "summarize_replay", "to_argentic_schema", "verify_due",
]
