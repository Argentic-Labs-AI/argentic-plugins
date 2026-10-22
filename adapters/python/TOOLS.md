# Retry-safe tools (Python)

`argentic_labs.tools.tool_pack` is the same tool pack as the TypeScript client's, with the same behavior and the same edges. Read [the TypeScript notes](../typescript/TOOLS.md) for what Stripe, Resend, Slack, GitHub, SMTP and HTTP can and cannot promise. Nothing here is exactly-once.

```python
import os
from argentic_labs import Argentic, run_durable, model_from_env
from argentic_labs.tools import tool_pack

tools = tool_pack(
    stripe={"secret_key": os.environ["STRIPE_SECRET_KEY"], "max_amount": 50_000},
    resend={"api_key": os.environ["RESEND_API_KEY"], "from": "Support <support@example.com>"},
    slack={"token": os.environ["SLACK_BOT_TOKEN"], "channels": ["C0SUPPORT"]},
    github={"token": os.environ["GITHUB_TOKEN"], "repos": ["acme/app"]},
    http={"allow_hosts": ["hooks.example.com"]},
    state_path=".argentic-intents.json",
)
run_durable(Argentic(), agent="support", run_id="order-1182", task=task, tools=tools,
            ledger_path=".argentic-ledger.json", model=model_from_env())
```

Options mirror the TypeScript ones in snake_case: `stripe {secret_key, max_amount}`, `resend {api_key, from}`, `smtp {host, port, secure, user, password, from, on_ambiguous}`, `slack {token, channels, on_ambiguous}`, `github {token, repos, on_ambiguous}`, `http {allow_hosts, headers, allow_http}`, and `tries`, `backoff`, `state_path`. `base_url` on each service points it at a test server.

When the outcome of a call is unknown and the same call is safe to try again, a tool raises `RetryLater`. `run_durable` does not write it to the ledger; the run stops, and running it again asks for the same action with the same key.

Tests: `python -m unittest discover -s tests` (20 tests, mock providers that commit an effect and then drop the connection). The local-engine run in the TypeScript suite covers the engine side; the Python tests do not start one.
