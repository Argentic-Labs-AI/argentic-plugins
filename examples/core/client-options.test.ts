import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { Argentic, ArgenticError, Ledger, defaultTimeoutMs, freeModel } from '../../adapters/typescript/argentic.ts'

const answer = { status: 'done', reply: 'hi', spent_usd: 0, turns: 1, wake_id: 'wk_1' }
let delayMs = 0
const seen: Record<string, string | string[] | undefined>[] = []
let server: Server
let baseUrl: string
let dir: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'argentic-options-'))
  server = createServer(async (req, res) => {
    for await (const _ of req) void _
    seen.push({ ...req.headers })
    await new Promise((r) => setTimeout(r, delayMs))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  delayMs = 0
  seen.length = 0
  delete process.env.MODEL_KEY
})

const body = { message: 'hi', model: freeModel }

test('modelKey defaults to the MODEL_KEY environment variable', async () => {
  process.env.MODEL_KEY = 'mk_env'
  await new Argentic({ apiKey: 'k', baseUrl }).wake('a', body, 'k.0')
  assert.equal(seen[0]['x-model-key'], 'mk_env')
})

test('an explicit modelKey beats the environment, and with neither there is no header', async () => {
  process.env.MODEL_KEY = 'mk_env'
  await new Argentic({ apiKey: 'k', baseUrl, modelKey: 'mk_arg' }).wake('a', body, 'k.0')
  assert.equal(seen[0]['x-model-key'], 'mk_arg')
  delete process.env.MODEL_KEY
  await new Argentic({ apiKey: 'k', baseUrl }).wake('a', body, 'k.1')
  assert.equal(seen[1]['x-model-key'], undefined)
})

test('the default timeout outlasts a long wake', () => {
  assert.equal(defaultTimeoutMs, 300_000)
})

test('a request that takes longer than timeoutMs is a network failure, retried and then given up on', async () => {
  delayMs = 400
  const sleeps: number[] = []
  const client = new Argentic({ apiKey: 'k', baseUrl, timeoutMs: 100, backoffMs: [1, 2], sleep: async (ms) => void sleeps.push(ms) })
  await assert.rejects(client.wake('a', body, 'k.0'), (e: unknown) => {
    assert.ok(e instanceof ArgenticError)
    assert.equal(e.status, undefined)
    assert.match(e.message, /gave up after 3 tries/)
    return true
  })
  assert.deepEqual(sleeps, [1, 2])
})

test('timeoutMs 0 means no limit', async () => {
  delayMs = 150
  const r = await new Argentic({ apiKey: 'k', baseUrl, timeoutMs: 0 }).wake('a', body, 'k.0')
  assert.equal(r.status, 'done')
})

test('a missing ledger file starts empty without a warning', () => {
  const warnings: string[] = []
  const ledger = new Ledger(join(dir, 'nope.json'), (m) => warnings.push(m))
  assert.equal(ledger.get('a:1'), undefined)
  assert.deepEqual(warnings, [])
})

test('a corrupt ledger warns, starts empty, and keeps the old file aside', () => {
  const path = join(dir, 'corrupt.json')
  writeFileSync(path, '{"entries": {"a:1": ')
  const warnings: string[] = []
  const ledger = new Ledger(path, (m) => warnings.push(m))
  assert.equal(ledger.get('a:1'), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not valid/)
  assert.match(warnings[0], /finished actions may run again/)
  assert.match(warnings[0], /corrupt\.json\.corrupt/)
  assert.equal(readFileSync(`${path}.corrupt`, 'utf8'), '{"entries": {"a:1": ')
  assert.equal(existsSync(path), false)
  ledger.set('a:2', { tool: 't', args: {}, result: 1, at: 'now' })  // and it works again
  assert.equal(new Ledger(path).get('a:2')?.result, 1)
})

test('JSON that is not an object is corrupt too, and a good ledger loads silently', () => {
  const warnings: string[] = []
  const bad = join(dir, 'list.json')
  writeFileSync(bad, '[1, 2]')
  new Ledger(bad, (m) => warnings.push(m))
  assert.equal(warnings.length, 1)
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify({ entries: { 'a:1': { tool: 't', args: {}, result: 5, at: 'x' } } }))
  assert.equal(new Ledger(good, (m) => warnings.push(m)).get('a:1')?.result, 5)
  assert.equal(warnings.length, 1)
})
