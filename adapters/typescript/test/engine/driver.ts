// One "process" of an agent that uses the tool pack against the mock providers. The test kills it or lets it
// stop on RetryLater, then starts it again with the same state; exit code 3 means "stopped, run me again".
import { Argentic, RetryLater, runDurable } from '../../argentic.ts'
import { toolPack } from '../../tools.ts'

const e = process.env as Record<string, string>
const tools = toolPack({
  stripe: { secretKey: 'sk_test_mock', baseUrl: e.STRIPE_URL },
  resend: { apiKey: 're_mock', from: 'Argentic <account@getargentic.com>', baseUrl: e.RESEND_URL },
  slack: { token: 'xoxb-mock', baseUrl: e.SLACK_URL },
  github: { token: 'ghp_mock', baseUrl: e.GITHUB_URL },
  http: { allowHosts: [new URL(e.HTTP_URL).host], allowHttp: true },
  statePath: `${e.STATE_DIR}/intents.json`,
  tries: Number(e.TRIES ?? 1),
  sleep: async () => {},
})
try {
  const out = await runDurable({
    client: new Argentic({ apiKey: e.API_KEY, modelKey: 'mock-model-key', baseUrl: e.BASE_URL }),
    agent: e.AGENT,
    runId: e.RUN_ID,
    task: 'Order 1182 arrived broken. Refund it, tell the customer, tell support, file an issue and notify the warehouse.',
    system: 'Call one tool per turn.',
    tools,
    ledgerPath: `${e.STATE_DIR}/ledger.json`,
    log: () => {},
    crashAfterActions: Number(e.CRASH_AFTER) || undefined,
  })
  console.log(JSON.stringify({ status: out.status, reply: out.reply }))
} catch (err) {
  if (err instanceof RetryLater) {
    console.log(JSON.stringify({ retryLater: err.message }))
    process.exit(3)
  }
  throw err
}
