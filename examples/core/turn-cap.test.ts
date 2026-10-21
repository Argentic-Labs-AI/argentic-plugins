import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Argentic, runDurable, type DurableTool } from '../../adapters/typescript/argentic.ts'

// A stand-in for the API's turn limit. The first wake reaches max_turns right after the agent asks to
// read a source, so it answers turn_cap and stays open. Asking that key again continues the same wake
// without the result (the agent saves a note that the source does not exist), as the API does. A new
// wake whose message carries the result lets the agent finish with it.
function fakeServer() {
  const answers = new Map<string, { body: string; json: object }>()
  const log: { key: string; message: string }[] = []
  let seq = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const send = (json: object, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(json))
    }
    const key = String(req.headers['idempotency-key'])
    const { message } = JSON.parse(raw) as { message: string }
    log.push({ key, message })
    const prior = answers.get(key)
    if (prior && (prior.json as { status: string }).status === 'done') return send(prior.json, { 'Idempotent-Replay': 'true' })
    let json: object
    if (prior) {
      // Same key on an open wake: it carries on blind.
      const read = (prior.json as { actions: object[] }).actions[0]
      json = { status: 'done', reply: 'No such source.', spent_usd: 0, turns: 2, wake_id: 'wk_0', resumed: true,
        actions: [read, { id: 2, tool: 'save_note', args: { text: 'no such source' }, seq: ++seq }] }
    } else if (message.includes('SRC-7')) {
      json = { status: 'done', reply: 'Summary: SRC-7', spent_usd: 0, turns: 1, wake_id: `wk_${answers.size}`, actions: [] }
    } else {
      json = { status: 'turn_cap', reply: null, spent_usd: 0, turns: 1, wake_id: `wk_${answers.size}`,
        actions: [{ id: 1, tool: 'read_source', args: { id: 'a' }, seq: ++seq }] }
    }
    answers.set(key, { body: raw, json })
    send(json)
  })
  return { server, log, reset: () => { answers.clear(); log.length = 0; seq = 0 } }
}

let dir: string
let fake: ReturnType<typeof fakeServer>
let baseUrl: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'argentic-turncap-'))
  fake = fakeServer()
  await new Promise<void>((r) => (fake.server as Server).listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`
})

after(() => {
  fake.server.close()
  rmSync(dir, { recursive: true, force: true })
})

class Crash extends Error {}

function setup(name: string) {
  fake.reset()
  const ran: string[] = []
  const tools: DurableTool[] = [
    { name: 'read_source', description: 'Read a source', parameters: { type: 'object', properties: { id: { type: 'string' } } }, execute: () => { ran.push('read_source'); return 'SRC-7' } },
    { name: 'save_note', description: 'Save a note', parameters: { type: 'object', properties: { text: { type: 'string' } } }, execute: () => { ran.push('save_note'); return 'ok' } },
  ]
  const client = new Argentic({ apiKey: 'test-key', baseUrl, sleep: async () => {} })
  const run = (crash = false) =>
    runDurable({
      client, agent: 'turncap-test', runId: 'r', task: 'Read source a and sum it up.', tools,
      ledgerPath: join(dir, `${name}.json`), log: () => {},
      onAction: crash ? () => { throw new Crash('simulated crash') } : undefined,
    })
  return { ran, run }
}

test('the results of a turn_cap wake are sent in the next wake', async () => {
  const { ran, run } = setup('plain')
  const out = await run()
  assert.equal(out.status, 'done')
  assert.equal(out.reply, 'Summary: SRC-7')
  assert.deepEqual(ran, ['read_source'])
  assert.deepEqual(fake.log.map((l) => l.key), ['r.0', 'r.1'])
  assert.match(fake.log[1].message, /^Results of the tools you asked for:\n\[\{"tool":"read_source","seq":1,"result":"SRC-7"\}\]$/)
})

test('a crash after a turn_cap wake\'s action resumes by sending its result, not by asking the wake again', async () => {
  const { ran, run } = setup('crash')
  await assert.rejects(run(true), Crash)
  const out = await run()
  assert.equal(out.reply, 'Summary: SRC-7')
  assert.deepEqual(ran, ['read_source'])
  assert.deepEqual(fake.log.map((l) => l.key), ['r.0', 'r.1'])

  // A rerun of the finished run asks nothing new and repeats nothing.
  const again = await run()
  assert.equal(again.reply, 'Summary: SRC-7')
  assert.deepEqual(ran, ['read_source'])
  assert.deepEqual(fake.log.map((l) => l.key), ['r.0', 'r.1', 'r.1'])
})
