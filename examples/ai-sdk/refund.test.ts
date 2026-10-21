import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Argentic, ArgenticError, runDurable } from '../../adapters/typescript/argentic.ts'
import { fromAiSdkTools } from '../../adapters/typescript/ai-sdk.ts'
import { makeTools, outboxCounts, system, task } from './refund.ts'

// An in-process stand-in for the Argentic API: stored answers per key, seq per agent,
// a scripted model, one 409 and one 503.
const script = [
  { tool: 'refund_order', args: { order_id: '1182', amount_usd: 42 } },
  { tool: 'send_email', args: { to: 'dana@example.com', subject: 'Refund', body: 'Your refund is on its way.' } },
  { tool: 'close_ticket', args: { ticket_id: 'T-77', note: 'Refunded and emailed.' } },
]

function fakeServer() {
  const answers = new Map<string, { body: string; json: object }>()
  const seqs = new Map<string, number>()
  const log: { key: string; replay: boolean; message: string }[] = []
  let requests = 0
  let wakes = 0
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const send = (code: number, json: object, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(json))
    }
    if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: 'unauthorized' })
    const agent = decodeURIComponent(req.url!.split('/')[3])
    if (req.url!.endsWith('/replay')) {
      return send(200, { agent, turns: [{ turn_seq: 1, wake_id: 'wk_1', match: true }], matched: 1, mismatched: 0, unverifiable: 0 })
    }
    requests++
    if (requests === 1) return send(409, { status: 'queued', retry_after: 0 })
    if (requests === 3) return send(503, { error: 'unavailable' })
    const key = String(req.headers['idempotency-key'])
    const prior = answers.get(key)
    if (prior) {
      if (prior.body !== raw) return send(422, { error: 'idempotency_key_reused' })
      log.push({ key, replay: true, message: JSON.parse(raw).message })
      return send(200, prior.json, { 'Idempotent-Replay': 'true' })
    }
    log.push({ key, replay: false, message: JSON.parse(raw).message })
    const turn = script[wakes]
    const wakeId = `wk_${String(wakes).padStart(18, '0')}`
    wakes++
    let json: object
    if (turn) {
      const seq = (seqs.get(agent) ?? 0) + 1
      seqs.set(agent, seq)
      json = { status: 'done', reply: '', spent_usd: 0, turns: 1, wake_id: wakeId, actions: [{ id: `a${seq}`, ...turn, seq }] }
    } else {
      json = { status: 'done', reply: 'Refunded, emailed and closed.', spent_usd: 0, turns: 1, wake_id: wakeId }
    }
    answers.set(key, { body: raw, json })
    send(200, json)
  })
  return { server, log }
}

let dir: string
let fake: ReturnType<typeof fakeServer>
let baseUrl: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'argentic-test-'))
  fake = fakeServer()
  await new Promise<void>((r) => (fake.server as Server).listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`
})

after(() => {
  fake.server.close()
  rmSync(dir, { recursive: true, force: true })
})

class Crash extends Error {}

test('a crash after the first action resumes without repeating it', async () => {
  const outbox = join(dir, 'outbox.jsonl')
  const client = new Argentic({ apiKey: 'test-key', baseUrl, backoffMs: [0, 0, 0, 0], sleep: async () => {} })
  const run = async (crash: boolean) =>
    runDurable({
      client,
      agent: 'refund-demo-test',
      runId: 'run-test',
      task,
      system,
      tools: await fromAiSdkTools(makeTools(outbox)),
      ledgerPath: join(dir, 'ledger.json'),
      log: () => {},
      onAction: crash
        ? ({ executed }) => {
            if (executed === 1) throw new Crash('simulated crash')
          }
        : undefined,
    })

  await assert.rejects(run(true), Crash)
  assert.deepEqual(outboxCounts(outbox), { refund_order: 1, send_email: 0, close_ticket: 0 })

  const out = await run(false)
  assert.equal(out.reply, 'Refunded, emailed and closed.')
  assert.equal(out.status, 'done')
  assert.deepEqual(outboxCounts(outbox), { refund_order: 1, send_email: 1, close_ticket: 1 })
  assert.equal(readFileSync(outbox, 'utf8').trim().split('\n').length, 3)

  // Step 0 was asked again with the same key and answered from the stored copy.
  const step0 = fake.log.filter((l) => l.key === 'run-test.0')
  assert.equal(step0.length, 2)
  assert.equal(step0[1].replay, true)
  assert.equal(step0[0].message, step0[1].message)
  // The follow-up message is built from the ledger, so a rerun would send the same bytes.
  assert.match(fake.log.find((l) => l.key === 'run-test.1')!.message, /^Results of the tools you asked for:\n\[\{"tool":"refund_order","seq":1/)
})

test('replay returns a summary shape', async () => {
  const client = new Argentic({ apiKey: 'test-key', baseUrl })
  const r = await client.replay('refund-demo-test', 'wk_000000000000000000')
  assert.equal(r.turns.length, 1)
  assert.equal(r.mismatched, 0)
})

test('the same key with a different body is an error', async () => {
  const client = new Argentic({ apiKey: 'test-key', baseUrl })
  const model = { provider: 'nvidia', id: 'x', prices: { in: 0, out: 0 } }
  await assert.rejects(
    client.wake('refund-demo-test', { message: 'different', model }, 'run-test.0'),
    (e: unknown) => e instanceof ArgenticError && e.status === 422,
  )
})
