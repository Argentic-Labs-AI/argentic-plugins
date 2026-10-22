import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { RetryLater, type DurableTool } from '../argentic.ts'
import { toolPack, providerKey, type ToolPackOptions } from '../tools.ts'
import { githubMock, httpMock, resendMock, slackMock, smtpMock, stripeMock, type Mock, type SmtpMock } from './mocks.ts'

let dir: string
before(() => { dir = mkdtempSync(join(tmpdir(), 'argentic-tools-')) })
after(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const fresh = () => join(dir, `intents-${++n}.json`)
const noSleep = async () => {}
/** A "process": tools built from a state file. A new call to pack() with the same file is a restart. */
const pack = (o: ToolPackOptions, statePath: string, tries = 1) => toolPack({ ...o, statePath, tries, sleep: noSleep })
const tool = (tools: DurableTool[], name: string) => tools.find((t) => t.name === name)!
const run = (tools: DurableTool[], name: string, args: object, key: string) =>
  tool(tools, name).execute(args, { seq: 1, idempotencyKey: key }) as Promise<any>

// ---- Stripe ----------------------------------------------------------------------------

test('stripe: a refund whose answer was lost is not made twice after a restart', async () => {
  const m = await stripeMock()
  const o = { stripe: { secretKey: 'sk_test_mock', baseUrl: m.url } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'stripe_refund', { payment_intent: 'pi_1', amount: 4200 }, 'agent:1'), RetryLater)
  assert.equal(m.effects.length, 1)
  // New process, same state file: asks again with the same key and Stripe answers from its stored copy.
  const out = await run(pack(o, state), 'stripe_refund', { payment_intent: 'pi_1', amount: 4200 }, 'agent:1')
  assert.equal(out.ok, true)
  assert.equal(out.replayed, true)
  assert.equal(m.effects.length, 1)
  await m.close()
})

test('stripe: the provider covers a crash even when the local state is gone', async () => {
  const m = await stripeMock()
  const o = { stripe: { secretKey: 'sk_test_mock', baseUrl: m.url } }
  const args = { customer: 'cus_1', payment_method: 'pm_1', amount: 1999, currency: 'USD' }
  await run(pack(o, fresh()), 'stripe_charge', args, 'agent:2')
  await run(pack(o, fresh()), 'stripe_charge', args, 'agent:2') // fresh state file: only Stripe remembers
  assert.equal(m.effects.length, 1)
  assert.equal(m.effects[0].currency, 'usd')
  assert.equal(m.effects[0].off_session, 'true')
  assert.equal(m.requests[0].headers['idempotency-key'], 'agent:2')
  await m.close()
})

test('stripe: a finished action returns its stored result without a call', async () => {
  const m = await stripeMock()
  const t = pack({ stripe: { secretKey: 'sk_test_mock', baseUrl: m.url } }, fresh())
  const a = await run(t, 'stripe_refund', { payment_intent: 'pi_1', amount: 100 }, 'agent:3')
  const b = await run(t, 'stripe_refund', { payment_intent: 'pi_1', amount: 100 }, 'agent:3')
  assert.deepEqual(a, b)
  assert.equal(m.requests.length, 1)
  await m.close()
})

test('stripe: a decline is a result for the model, and the amount cap holds', async () => {
  const m = await stripeMock()
  const t = pack({ stripe: { secretKey: 'sk_test_mock', baseUrl: m.url, maxAmount: 5000 } }, fresh())
  const declined = await run(t, 'stripe_charge', { customer: 'cus_1', payment_method: 'pm_declined', amount: 100, currency: 'usd' }, 'agent:4')
  assert.equal(declined.ok, false)
  assert.equal(declined.code, 'card_declined')
  const over = await run(t, 'stripe_refund', { payment_intent: 'pi_1', amount: 5001 }, 'agent:5')
  assert.match(over.error, /over the limit/)
  const whole = await run(t, 'stripe_refund', { payment_intent: 'pi_1' }, 'agent:6')
  assert.match(whole.error, /needs an amount/)
  assert.equal(m.requests.length, 1)
  await m.close()
})

test('stripe: a long key is hashed under the 255 limit', () => {
  const k = 'a'.repeat(400)
  assert.ok(providerKey(k).length <= 255)
  assert.equal(providerKey('agent:1'), 'agent:1')
})

// ---- Resend ----------------------------------------------------------------------------

test('resend: a lost answer then a restart sends one email', async () => {
  const m = await resendMock()
  const o = { resend: { apiKey: 're_mock', from: 'Argentic <account@getargentic.com>', baseUrl: m.url } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'send_email', { to: 'dana@example.com', subject: 'Refund', body: 'On its way.' }, 'agent:7'), RetryLater)
  const out = await run(pack(o, state), 'send_email', { to: 'dana@example.com', subject: 'Refund', body: 'On its way.' }, 'agent:7')
  assert.equal(out.ok, true)
  assert.equal(m.effects.length, 1)
  assert.equal(m.effects[0].from, 'Argentic <account@getargentic.com>')
  await m.close()
})

test('resend: in-process retries use the same key', async () => {
  const m = await resendMock()
  m.dropNext = 1
  const t = pack({ resend: { apiKey: 're_mock', from: 'a@b.co', baseUrl: m.url } }, fresh(), 4)
  const out = await run(t, 'send_email', { to: 'x@y.co', subject: 's', body: 'b' }, 'agent:8')
  assert.equal(out.ok, true)
  assert.equal(m.effects.length, 1)
  assert.equal(m.requests.length, 2)
  assert.equal(new Set(m.requests.map((r) => r.headers['idempotency-key'])).size, 1)
  await m.close()
})

// ---- HTTP ------------------------------------------------------------------------------

test('http_post: the key goes in the header, only allowed hosts are called, a receiver that dedupes sees one effect', async () => {
  const m = await httpMock({ honorsKey: true })
  const host = new URL(m.url).host
  const o = { http: { allowHosts: [host], allowHttp: true, headers: { Authorization: 'Bearer hook' } } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'http_post', { url: m.url + '/deploy', body: '{"v":1}' }, 'agent:9'), RetryLater)
  const out = await run(pack(o, state), 'http_post', { url: m.url + '/deploy', body: '{"v":1}' }, 'agent:9')
  assert.equal(out.ok, true)
  assert.equal(out.replayed, true)
  assert.equal(m.effects.length, 1)
  assert.equal(m.requests[0].headers.authorization, 'Bearer hook')
  const t = pack(o, fresh())
  assert.match((await run(t, 'http_post', { url: 'http://evil.example/x', body: '{}' }, 'agent:10')).error, /not allowed/)
  assert.match((await run(pack({ http: { allowHosts: [host] } }, fresh()), 'http_post', { url: m.url + '/x', body: '{}' }, 'agent:11')).error, /only https/)
  await m.close()
})

test('http_post: a receiver that ignores the key can see the request twice (the documented edge)', async () => {
  const m = await httpMock({ honorsKey: false })
  const o = { http: { allowHosts: [new URL(m.url).host], allowHttp: true } }
  m.dropNext = 1
  const t = pack(o, fresh(), 3)
  const out = await run(t, 'http_post', { url: m.url + '/x', body: '{}' }, 'agent:12')
  assert.equal(out.ok, true)
  assert.equal(m.effects.length, 2)
  await m.close()
})

// ---- Slack -----------------------------------------------------------------------------

test('slack: a post whose answer was lost is found by its marker and not posted again', async () => {
  const m = await slackMock({ history: true })
  const o = { slack: { token: 'xoxb-mock', baseUrl: m.url, channels: ['C1'] } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Deployed.' }, 'agent:13'), RetryLater)
  assert.equal(m.effects.length, 1)
  const out = await run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Deployed.' }, 'agent:13')
  assert.equal(out.ok, true)
  assert.equal(out.found, true)
  assert.equal(m.effects.length, 1)
  assert.deepEqual(m.effects[0].metadata, { event_type: 'argentic_action', event_payload: { key: 'agent:13' } })
  await m.close()
})

test('slack: with no history scope a maybe-sent post is held, not repeated', async () => {
  const m = await slackMock({ history: false })
  const o = { slack: { token: 'xoxb-mock', baseUrl: m.url } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Hi' }, 'agent:14'), RetryLater)
  const out = await run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Hi' }, 'agent:14')
  assert.equal(out.outcome, 'unknown')
  assert.equal(m.effects.length, 1)
  await m.close()
})

test('slack: onAmbiguous retry posts again when it cannot check (the other side of the trade)', async () => {
  const m = await slackMock({ history: false })
  const o = { slack: { token: 'xoxb-mock', baseUrl: m.url, onAmbiguous: 'retry' as const } }
  const state = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Hi' }, 'agent:15'), RetryLater)
  await run(pack(o, state), 'slack_post_message', { channel: 'C1', text: 'Hi' }, 'agent:15')
  assert.equal(m.effects.length, 2)
  await m.close()
})

test('slack: a channel outside the allow list is refused before any call', async () => {
  const m = await slackMock({ history: true })
  const t = pack({ slack: { token: 'xoxb-mock', baseUrl: m.url, channels: ['C1'] } }, fresh())
  assert.match((await run(t, 'slack_post_message', { channel: 'C9', text: 'x' }, 'agent:16')).error, /not allowed/)
  assert.equal(m.requests.length, 0)
  await m.close()
})

// ---- GitHub ----------------------------------------------------------------------------

test('github: an issue whose answer was lost is found by its marker after a restart', async () => {
  const m = await githubMock()
  const o = { github: { token: 'ghp_mock', baseUrl: m.url, repos: ['acme/app'] } }
  const state = fresh()
  m.dropNext = 1
  const args = { repo: 'acme/app', title: 'Refund failed', body: 'Order 1182' }
  await assert.rejects(run(pack(o, state), 'github_create_issue', args, 'agent:17'), RetryLater)
  const out = await run(pack(o, state), 'github_create_issue', args, 'agent:17')
  assert.equal(out.ok, true)
  assert.equal(out.found, true)
  assert.equal(m.effects.length, 1)
  assert.match(m.effects[0].body, /<!-- argentic-key:agent:17 -->/)
  await m.close()
})

test('github: a comment is found the same way, and an unlistable repo holds instead of repeating', async () => {
  const m = await githubMock()
  const o = { github: { token: 'ghp_mock', baseUrl: m.url } }
  const state = fresh()
  const args = { repo: 'acme/app', issue_number: 7, body: 'Fixed.' }
  m.dropNext = 1
  await assert.rejects(run(pack(o, state), 'github_create_comment', args, 'agent:18'), RetryLater)
  const found = await run(pack(o, state), 'github_create_comment', args, 'agent:18')
  assert.equal(found.found, true)
  assert.equal(m.effects.length, 1)

  const state2 = fresh()
  m.dropNext = 1
  await assert.rejects(run(pack(o, state2), 'github_create_comment', args, 'agent:19'), RetryLater)
  ;(m as any).listBroken = true
  const held = await run(pack(o, state2), 'github_create_comment', args, 'agent:19')
  assert.equal(held.outcome, 'unknown')
  assert.equal(m.effects.length, 2)
  await m.close()
})

test('github: a repo outside the allow list is refused', async () => {
  const m = await githubMock()
  const t = pack({ github: { token: 'ghp_mock', baseUrl: m.url, repos: ['acme/app'] } }, fresh())
  assert.match((await run(t, 'github_create_issue', { repo: 'other/app', title: 't' }, 'agent:20')).error, /not allowed/)
  assert.equal(m.requests.length, 0)
  await m.close()
})

// ---- SMTP ------------------------------------------------------------------------------

let smtp: SmtpMock
before(async () => { smtp = await smtpMock() })
after(async () => { await smtp.close() })
const smtpOpts = (extra: object = {}) => ({ smtp: { host: '127.0.0.1', port: smtp.port, user: 'user', pass: 'pass', from: 'Argentic <account@getargentic.com>', ...extra } })

test('smtp: sends once, with a stable Message-ID and the key in a header', async () => {
  smtp.messages.length = 0
  const t = pack(smtpOpts(), fresh())
  const args = { to: 'dana@example.com', subject: 'Refund', body: 'Line one\n.starts with a dot' }
  const a = await run(t, 'send_email', args, 'agent:21')
  const b = await run(t, 'send_email', args, 'agent:21')
  assert.equal(a.ok, true)
  assert.deepEqual(a, b)
  assert.equal(smtp.messages.length, 1)
  assert.match(smtp.messages[0].data, new RegExp(`Message-ID: ${a.messageId.replace(/[<>.]/g, '\\$&')}`))
  assert.match(smtp.messages[0].data, /X-Argentic-Idempotency-Key: agent:21/)
  assert.match(smtp.messages[0].data, /\r\n\.\.starts with a dot/)
})

test('smtp: cut off after the message was handed over, it is held, not sent again', async () => {
  smtp.messages.length = 0
  const state = fresh()
  smtp.dropAfterData = 1
  const out = await run(pack(smtpOpts(), state), 'send_email', { to: 'a@b.co', subject: 's', body: 'b' }, 'agent:22')
  assert.equal(out.outcome, 'unknown')
  assert.equal(smtp.messages.length, 1)
  const again = await run(pack(smtpOpts(), state), 'send_email', { to: 'a@b.co', subject: 's', body: 'b' }, 'agent:22')
  assert.equal(again.outcome, 'unknown')
  assert.equal(smtp.messages.length, 1)
})

test('smtp: onAmbiguous retry sends again, with the same Message-ID (the documented edge)', async () => {
  smtp.messages.length = 0
  smtp.dropAfterData = 1
  const out = await run(pack(smtpOpts({ onAmbiguous: 'retry' }), fresh(), 3), 'send_email', { to: 'a@b.co', subject: 's', body: 'b' }, 'agent:23')
  assert.equal(out.ok, true)
  assert.equal(smtp.messages.length, 2)
  const ids = smtp.messages.map((m) => m.data.match(/Message-ID: (\S+)/)![1])
  assert.equal(ids[0], ids[1])
})

test('smtp: a killed process (intent started, never finished) holds on resume', async () => {
  smtp.messages.length = 0
  const state = fresh()
  const t = pack(smtpOpts(), state)
  // Simulate the death: the intent is on disk, the send never reported back.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(state, JSON.stringify({ entries: { 'agent:24': { state: 'started', tool: 'send_email', at: new Date().toISOString() } } }))
  const out = await run(pack(smtpOpts(), state), 'send_email', { to: 'a@b.co', subject: 's', body: 'b' }, 'agent:24')
  assert.equal(out.outcome, 'unknown')
  assert.equal(smtp.messages.length, 0)
  void t
})

test('smtp: a refused recipient is a result, and the intent file exists', async () => {
  const state = fresh()
  const out = await run(pack(smtpOpts(), state), 'send_email', { to: 'bad@example.com', subject: 's', body: 'b' }, 'agent:25')
  assert.equal(out.ok, false)
  assert.match(out.error, /550/)
  assert.ok(existsSync(state))
})

test('toolPack builds only what is configured, and names both email tools when both are set', async () => {
  const m = await resendMock()
  const names = (o: ToolPackOptions) => toolPack({ ...o, statePath: fresh() }).map((t) => t.name)
  assert.deepEqual(names({}), [])
  assert.deepEqual(names({ ...smtpOpts(), resend: { apiKey: 'k', from: 'a@b.co', baseUrl: m.url } }), ['send_email', 'send_email_smtp'])
  assert.deepEqual(names({ stripe: { secretKey: 'k' }, github: { token: 't' } }), ['stripe_refund', 'stripe_charge', 'github_create_issue', 'github_create_comment'])
  await m.close()
})
