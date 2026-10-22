import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Argentic, WebhookVerificationError, handleDue, handleDueResponse, signNotice, verifyDue, type ModelSpec } from '../argentic.ts'
import { httpMock, type Mock } from './mocks.ts'

// One fixed vector, asserted in Python too (tests/test_due.py) and checked against the hosted engine's signer.
const SECRET = 'whsec_YXJnZW50aWMtdGVzdC12ZWN0b3Itc2VjcmV0LTMyYnk='
const ID = 'due_t1_support-bot_inbox_1792659600'
const TS = 1792659660
const BODY = '{"type":"agent.due","agent":"support-bot","memory":"inbox","reasons":["plan wake_at"],"since":"2026-10-22T09:00:00.000Z"}'
const SIG = 'v1,iM71zq14eEYiwx4iyGblF5PjAh2S7FVivBkCxqGCavY='
const NOW = () => TS * 1000
const MODEL: ModelSpec = { provider: 'p', id: 'm', prices: { in: 0, out: 0 } }

const headers = (over: Record<string, string | undefined> = {}) => {
  const h: Record<string, string | undefined> = { 'webhook-id': ID, 'webhook-timestamp': String(TS), 'webhook-signature': SIG, ...over }
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>
}
const req = (over: Record<string, string | undefined> = {}, body = BODY) => ({ body, headers: headers(over) })

const wakeServer = (): Promise<Mock> => httpMock({ honorsKey: false }).then(async (m) => {
  m.server.removeAllListeners('request')
  m.server.on('request', async (r, res) => {
    let body = ''
    for await (const c of r) body += c
    m.requests.push({ method: r.method!, path: r.url!, headers: r.headers, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'done', reply: 'ok', spent_usd: 0, turns: 1, wake_id: 'wk_1' }))
  })
  return m
})

async function withWake(fn: (m: Mock, opts: { client: Argentic; secret: string; now: () => number; model: ModelSpec }) => Promise<void>) {
  const m = await wakeServer()
  try {
    await fn(m, { client: new Argentic({ apiKey: 'aek_test', modelKey: 'mk_customer', baseUrl: m.url }), secret: SECRET, now: NOW, model: MODEL })
  } finally {
    await m.close()
  }
}

test('the shared vector: signNotice reproduces the signature', () => {
  assert.equal(signNotice(SECRET, ID, TS, BODY), SIG)
})

test('a valid notice wakes with fire_due, the customer model key, the agent path and the memory', async () => {
  await withWake(async (m, o) => {
    const out = await handleDue(req(), o)
    assert.equal(out.notice.agent, 'support-bot')
    assert.equal(out.wake.wake_id, 'wk_1')
    assert.equal(m.requests.length, 1)
    const r = m.requests[0]
    assert.equal(r.path, '/v1/agents/support-bot/wake')
    assert.equal(r.headers['x-model-key'], 'mk_customer')
    assert.equal(r.headers['authorization'], 'Bearer aek_test')
    assert.equal(r.headers['idempotency-key'], ID)
    const sent = JSON.parse(r.body)
    assert.deepEqual(sent, { fire_due: true, memory: 'inbox', model: MODEL })
    assert.ok(!('message' in sent))
  })
})

test('a null memory is left out of the wake', async () => {
  await withWake(async (m, o) => {
    const body = BODY.replace('"memory":"inbox"', '"memory":null')
    const sig = signNotice(SECRET, ID, TS, body)
    await handleDue(req({ 'webhook-signature': sig }, body), o)
    assert.ok(!('memory' in JSON.parse(m.requests[0].body)))
  })
})

test('a Fetch Request works, header names in any case', async () => {
  await withWake(async (m, o) => {
    const r = new Request('https://x.test/due', { method: 'POST', body: BODY, headers: { 'Webhook-Id': ID, 'Webhook-Timestamp': String(TS), 'Webhook-Signature': SIG } })
    const res = await handleDueResponse(r, o)
    assert.equal(res.status, 200)
    assert.equal(m.requests.length, 1)
  })
})

test('several signatures: one valid is enough, non-v1 entries are ignored', async () => {
  await withWake(async (m, o) => {
    const sigs = `v1,${Buffer.from('nope').toString('base64')} v2,${SIG.slice(3)} ${SIG}`
    await handleDue(req({ 'webhook-signature': sigs }), o)
    assert.equal(m.requests.length, 1)
  })
})

const fails = async (name: string, code: string, request: ReturnType<typeof req>, o: Record<string, unknown> = {}) => {
  await withWake(async (m, base) => {
    await assert.rejects(handleDue(request, { ...base, ...o }), (e: unknown) => e instanceof WebhookVerificationError && e.code === code, name)
    assert.equal(m.requests.length, 0, `${name}: no wake`)
  })
}

test('verification failures raise a specific error and never wake', async () => {
  await fails('wrong secret', 'bad_signature', req(), { secret: 'whsec_' + Buffer.from('another-secret-another-secret-12').toString('base64') })
  await fails('tampered body', 'bad_signature', req({}, BODY.replace('support-bot', 'other-bot')))
  await fails('only a v2 signature', 'bad_signature', req({ 'webhook-signature': 'v2,' + SIG.slice(3) }))
  await fails('stale', 'stale', req(), { now: () => (TS + 301) * 1000 })
  await fails('future', 'stale', req(), { now: () => (TS - 301) * 1000 })
  await fails('non-numeric timestamp', 'bad_timestamp', req({ 'webhook-timestamp': 'soon' }))
  for (const h of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) await fails(`missing ${h}`, 'missing_header', req({ [h]: undefined }))
  await fails('malformed secret', 'bad_secret', req(), { secret: 'whsec_not base64!' })
  await fails('empty secret', 'bad_secret', req(), { secret: 'whsec_' })
})

test('the window is adjustable and the edge is allowed', async () => {
  await verifyDue(req(), { secret: SECRET, now: () => (TS + 300) * 1000 })
  await assert.rejects(verifyDue(req(), { secret: SECRET, now: () => (TS + 301) * 1000, toleranceSeconds: 300 }))
  await verifyDue(req(), { secret: SECRET, now: () => (TS + 3000) * 1000, toleranceSeconds: 3600 })
})

test('the secret falls back to ARGENTIC_WEBHOOK_SECRET', async () => {
  const was = process.env.ARGENTIC_WEBHOOK_SECRET
  try {
    delete process.env.ARGENTIC_WEBHOOK_SECRET
    await assert.rejects(verifyDue(req(), { now: NOW }), (e: any) => e.code === 'bad_secret')
    process.env.ARGENTIC_WEBHOOK_SECRET = SECRET
    assert.equal((await verifyDue(req(), { now: NOW })).id, ID)
  } finally {
    if (was === undefined) delete process.env.ARGENTIC_WEBHOOK_SECRET
    else process.env.ARGENTIC_WEBHOOK_SECRET = was
  }
})

test('a signed notice of another type or without an agent is refused and never wakes', async () => {
  for (const body of ['{"type":"agent.other","agent":"a"}', '{"type":"agent.due"}', '{"type":"agent.due","agent":""}', 'not json']) {
    await fails(body, 'bad_body', req({ 'webhook-signature': signNotice(SECRET, ID, TS, body) }, body))
  }
})

test('handleDueResponse answers 200, 401, 400, 500 and 502', async () => {
  await withWake(async (m, o) => {
    assert.equal((await handleDueResponse(req(), o)).status, 200)
    assert.equal((await handleDueResponse(req({ 'webhook-signature': 'v1,AAAA' }), o)).status, 401)
    const bad = 'not json'
    assert.equal((await handleDueResponse(req({ 'webhook-signature': signNotice(SECRET, ID, TS, bad) }, bad), o)).status, 400)
    assert.equal((await handleDueResponse(req(), { ...o, secret: 'whsec_!' })).status, 500)
    assert.equal(m.requests.length, 1)
    const down = new Argentic({ apiKey: 'aek_test', baseUrl: m.url, backoffMs: [], fetch: async () => new Response('{"error":"nope"}', { status: 400 }) })
    assert.equal((await handleDueResponse(req(), { ...o, client: down })).status, 502)
  })
})
