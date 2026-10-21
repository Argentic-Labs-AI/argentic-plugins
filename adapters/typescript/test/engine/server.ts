// The hosted Argentic engine from an agent-lab checkout, on plain Node, with a scripted model in front of it.
// Real: the app, the journal, auth, idempotent wakes, the action seq. Fake: the model, which asks for the tool pack's
// tools one after another. No keys of any kind: start it under `env -i` (the test does).
//
//   env -i PATH="$PATH" HOME="$HOME" ENGINE_DIR=/path/to/agent-lab DATABASE_URL=postgres://... PORT=37201 \
//     HTTP_URL=http://127.0.0.1:1/hook node --experimental-transform-types server.ts
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.env.ENGINE_DIR
const url = process.env.DATABASE_URL
if (!dir || !url) throw new Error('ENGINE_DIR and DATABASE_URL are required')
const load = (p: string) => import(pathToFileURL(join(dir, p)).href)
const { connect } = await load('engine/db.ts')
const { apply_migrations, load_migrations } = await load('hosted/src/migrations.ts')
const { create_app } = await load('hosted/src/app.ts')
const { byo_model } = await load('hosted/src/model.ts')
const { create_tenant } = await load('hosted/src/store.ts')

const script: { name: string; args: () => object }[] = [
  { name: 'stripe_refund', args: () => ({ payment_intent: 'pi_1182', amount: 4200 }) },
  { name: 'send_email', args: () => ({ to: 'dana@example.com', subject: 'Your refund', body: 'Your refund is on its way.' }) },
  { name: 'slack_post_message', args: () => ({ channel: 'C0SUPPORT', text: 'Refunded order 1182.' }) },
  { name: 'github_create_issue', args: () => ({ repo: 'acme/app', title: 'Order 1182 arrived broken', body: 'Refunded; please check packaging.' }) },
  { name: 'http_post', args: () => ({ url: process.env.HTTP_URL ?? '', body: '{"order":1182,"status":"refunded"}' }) },
]

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The tool after the one in the last "Results of the tools" message (each wake carries only its own results). */
function nextCall(body: any): { name: string; args: object } | null {
  const msgs: any[] = body.messages ?? []
  if (msgs[msgs.length - 1]?.role === 'tool') return null
  const last = [...msgs].reverse().find((m) => m.role === 'user')
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  let at = -1
  if (text.includes('Results of the tools')) {
    const tools = (JSON.parse(text.slice(text.indexOf('\n') + 1)) as { tool: string }[]).map((r) => r.tool)
    at = Math.max(...tools.map((t) => script.findIndex((s) => s.name === t)))
  }
  const next = script[at + 1]
  return next ? { name: next.name, args: next.args() } : null
}

let ids = 0
const fakeModel = (async (_input: any, init: any = {}) => {
  const call = nextCall(JSON.parse(String(init.body ?? '{}')))
  return json(200, {
    id: 'chatcmpl-pack', object: 'chat.completion', created: 1, model: 'fake',
    choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${++ids}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: 'Refunded, emailed, posted, filed and notified.' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  })
}) as typeof fetch

const sql = connect(url, { schema: 'engine', max: 5 })
await apply_migrations(sql, load_migrations(dir))
const tenant = `pack-${Date.now().toString(36)}`
const key = await create_tenant(sql, { id: tenant, name: 'Tool pack e2e', rate_per_min: 600, daily_usd: 50, billed: false })
const app = create_app({ sql, make_model: (m: any, k: string) => byo_model(m, k, { fetch: fakeModel }) })

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const r: Response = await app.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }))
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(Buffer.from(await r.arrayBuffer()))
})
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: (server.address() as any).port, key }))
})
