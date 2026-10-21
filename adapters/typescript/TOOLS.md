# Retry-safe tools

`@argentic-labs/client/tools` gives `runDurable` tools for real services. Every action Argentic hands you carries a stable key (`agent:seq`), so a cut-off one can be retried safely. These tools use that key the way each provider allows.

```ts
import { Argentic, runDurable } from '@argentic-labs/client'
import { toolPack } from '@argentic-labs/client/tools'

const tools = toolPack({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY!, maxAmount: 50_000 },
  resend: { apiKey: process.env.RESEND_API_KEY!, from: 'Support <support@example.com>' },
  slack: { token: process.env.SLACK_BOT_TOKEN!, channels: ['C0SUPPORT'] },
  github: { token: process.env.GITHUB_TOKEN!, repos: ['acme/app'] },
  http: { allowHosts: ['hooks.example.com'] },
  statePath: '.argentic-intents.json',
})
await runDurable({ client, agent: 'support', runId: 'order-1182', ledgerPath: '.argentic-ledger.json', task, tools })
```

Pass only the services you use. Secrets, the From address and the allow lists come from your code, never from the model.

| Tool | Service | How a repeat is stopped |
|---|---|---|
| `stripe_refund`, `stripe_charge` | Stripe | `Idempotency-Key` header, the provider remembers |
| `send_email` | Resend | `Idempotency-Key` header, the provider remembers |
| `send_email` / `send_email_smtp` | any SMTP server | local intent log, fixed `Message-ID`, a hold when unsure |
| `slack_post_message` | Slack | the key rides in message metadata; looked up before a repeat |
| `github_create_issue`, `github_create_comment` | GitHub | a hidden marker in the body; looked up before a repeat |
| `http_post` | your endpoint | `Idempotency-Key` header, if the receiver honors it |

`stripe_charge` makes an off-session PaymentIntent with `confirm=true` for a saved customer and payment method.

## How a stop and a restart go

1. Before it calls out, a tool writes an intent (`started`) to `statePath`. After the answer it writes `done` with the result. A `done` intent returns its result and calls nothing.
2. If the network drops, a 429 or a 5xx comes back, the tool tries the same call again with the same key, up to `tries` times (default 4, with `backoffMs` waits). If that runs out it throws `RetryLater`.
3. `runDurable` does not write a `RetryLater` to the ledger. The run stops, and running it again asks for the same action with the same key. A tool that returned an ordinary error (a declined card, a refused recipient) is a finished action: the model sees the error and it is recorded.

## What each provider can promise

**Stripe.** The key is stored with the first answer, 24 hours at most; a repeat inside that window returns the first answer (`replayed: true`), and a repeat with different parameters is an error. Two edges: after 24 hours a reused key is a new request, so restart a stopped run within a day; and Stripe stores a 500 under the key and replays it, so a 5xx is returned as the result and not retried with the same key. Check the dashboard before asking again.

**Resend.** Same shape: the key is kept 24 hours and a repeat returns the first send. A key reused with a different body is refused.

**HTTP.** The header is sent. Whether a repeat is ignored is up to the receiver. A receiver that ignores it can see a request twice when an answer is lost; this tool cannot tell. Only hosts in `allowHosts` are called, redirects are refused, and `http://` needs `allowHttp`.

**Slack, GitHub.** Neither has an idempotency key. Instead the key is placed in the message (Slack `metadata`, GitHub a hidden `<!-- argentic-key:... -->` comment) and, when an earlier try may have landed, the tool lists recent messages, issues or comments for that marker first. Found: it returns the existing one (`found: true`) and posts nothing. This needs read access: Slack's history scope for the channel (`channels:history`, `groups:history`), and for GitHub read access to issues. GitHub lists are read directly, not through search, which lags. Two writers racing on the same key, such as a paused worker that wakes up after a takeover, can both pass the lookup before either posts; the key does not stop that, and a receiver that dedupes on it would.

**SMTP.** There is nothing to look up. The tool writes the intent first and sends a `Message-ID` derived from the key and an `X-Argentic-Idempotency-Key` header, which a receiving system can use to spot a copy. If the connection drops after the message was handed over, or the process died with an intent still `started`, nobody knows whether it was queued. The default (`onAmbiguous: 'hold'`) does not send it again and returns `outcome: 'unknown'` for the model to report. `onAmbiguous: 'retry'` sends it again and accepts a possible duplicate. Pick Resend if you want the stronger guarantee.

Where a lookup is impossible (no history scope, GitHub unreachable), Slack and GitHub follow the same `onAmbiguous` choice. Default `hold`.

## What this does not promise

Nothing here is exactly-once delivery. It narrows the window where a repeat can happen to the cases above, and names each one. A paused (not killed) worker that wakes after another took over can land an in-flight call late; the provider's key or the marker only helps if the receiver checks it.

## Tests

`npm test` runs 22 tests against mock providers that commit an effect and then drop the connection. With `ARGENTIC_ENGINE_DIR` (an agent-lab checkout) and `ENGINE_DATABASE_URL` (an empty Postgres) set, three more run a real hosted engine started under `env -i` with a scripted model: a SIGKILL after two actions, a lost first answer from every provider, and a finished run asked for again. No real keys are used anywhere.
