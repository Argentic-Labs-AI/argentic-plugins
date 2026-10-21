// Offline: a scripted Argentic API, a file store, a kill in the gap after the mail provider took the message.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runSession } from '../lib/run'
import { killKey, loadSession } from '../lib/session'
import { makeStore } from '../lib/store'

/** Answers like the real API for this story: look the order up, send the email, finish. Same key, same answer. */
function fakeApi() {
  const answered = new Map<string, unknown>()
  const calls: string[] = []
  const script = [
    { status: 'done', reply: '', spent_usd: 0, turns: 1, actions: [{ id: 'a1', tool: 'lookup_order', args: { order_id: '1182' }, seq: 1 }] },
    { status: 'done', reply: '', spent_usd: 0, turns: 1, actions: [{ id: 'a2', tool: 'send_email', args: { to: 'dana@example.com', subject: 'Sorry about order 1182', body: 'A replacement ships today.' }, seq: 2 }] },
    { status: 'done', reply: 'Emailed Dana about the replacement.', spent_usd: 0, turns: 1, actions: [] },
  ]
  const fetchFn = (async (url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)['Idempotency-Key']
    const step = Number(key.split('.').pop())
    calls.push(key)
    const replay = answered.has(key)
    if (!replay) answered.set(key, { ...script[step], wake_id: `w${step}` })
    return new Response(JSON.stringify(answered.get(key)), { status: 200, headers: { 'content-type': 'application/json', 'Idempotent-Replay': String(replay) } })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

test('kill after the mail left, resume: one email, the rest finishes', async () => {
  const store = makeStore({} as NodeJS.ProcessEnv)
  const sid = `t${Date.now().toString(36)}0000000`
  const api = fakeApi()
  const input = { store, sid, apiKey: 'aek_test', modelKey: 'k', baseUrl: 'http://engine.test', delayMs: 400, fetch: api.fetchFn }

  const first = runSession(input)
  // Wait until the provider has taken the message, then press Kill.
  for (let i = 0; i < 200; i++) {
    if ((await loadSession(store, sid)).outbox.length === 1) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const mid = await loadSession(store, sid)
  await store.set(killKey(sid), mid.attempt)
  const killed = await first
  assert.equal(killed.status, 'killed')
  assert.equal(killed.outbox.length, 1)
  assert.equal(killed.finished, 1, 'only the lookup finished; the send was cut off')

  const second = await runSession(input)
  assert.equal(second.status, 'done')
  assert.equal(second.outbox.length, 1, 'the resumed send hit the same key and did not send again')
  assert.equal(second.finished, 2)
  assert.ok(second.log.some((l) => l.kind === 'dup'))
  assert.ok(second.log.some((l) => l.kind === 'skip'))
  // The second run asked for turns 0 and 1 again with the same keys, so the API answered them from its journal.
  assert.deepEqual(api.calls, ['run-' + killed.agent.slice(8) + '.0', 'run-' + killed.agent.slice(8) + '.1', 'run-' + killed.agent.slice(8) + '.0', 'run-' + killed.agent.slice(8) + '.1', 'run-' + killed.agent.slice(8) + '.2'])
})
