import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { APICallError, generateText, jsonSchema, stepCountIs, streamText, tool as aiTool } from 'ai'
import * as aiTest from 'ai/test'
import { Argentic, canonical, sha256 } from '../argentic.ts'
import {
  ArgenticDivergence,
  ArgenticFenced,
  ArgenticSpendCap,
  ArgenticUnknownOutcome,
  ArgenticUnrecorded,
  durableRun,
  type DurableRun,
} from '../ai-sdk.ts'
import { FakeServer } from './fake-server.ts'

// ai 7 models are v4; ai 6 has v3. The wrapper must work under both.
const MockLanguageModelV4: any = (aiTest as any).MockLanguageModelV4 ?? (aiTest as any).MockLanguageModelV3
type MockLanguageModelV4 = any
const { simulateReadableStream } = aiTest as any

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const stopReason = { unified: 'stop', raw: 'stop' } as const
const callsReason = { unified: 'tool-calls', raw: 'tool_calls' } as const
const tool = (def: { description: string; inputSchema: unknown; execute: (input: any, options: any) => unknown }): any => aiTool(def as any)

const callStep = (...calls: [id: string, name: string, input: unknown][]) => ({
  content: calls.map(([id, name, input]) => ({ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) })),
  finishReason: callsReason,
  usage,
  warnings: [],
})
const textStep = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: stopReason, usage, warnings: [] })

/** A mock provider that plays `script` in order, and counts the calls that reach it. */
function provider(script: any[]) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async () => script[i++ % script.length],
    doStream: async () => {
      const step = script[i++ % script.length]
      const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
      let id = 0
      for (const c of step.content) {
        if (c.type === 'text') {
          chunks.push({ type: 'text-start', id: String(id) }, { type: 'text-delta', id: String(id), delta: c.text }, { type: 'text-end', id: String(id) })
          id++
        } else if (c.type === 'tool-call') {
          chunks.push(
            { type: 'tool-input-start', id: c.toolCallId, toolName: c.toolName },
            { type: 'tool-input-delta', id: c.toolCallId, delta: c.input },
            { type: 'tool-input-end', id: c.toolCallId },
            c,
          )
        }
      }
      chunks.push({ type: 'finish', finishReason: step.finishReason, usage: step.usage })
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

const input = jsonSchema<{ amount?: number }>({ type: 'object', properties: { amount: { type: 'number' } } })

function setup() {
  const server = new FakeServer()
  const client = new Argentic({ apiKey: 'aek_test', baseUrl: 'http://argentic.test', fetch: server.fetch as any, sleep: async () => {}, writeDeadlineMs: 5000 })
  const open = (runId: string, o: Record<string, unknown> = {}) => durableRun(client, { agent: 'refunds', runId, ...o })
  return { server, client, open }
}

/** The app's loop, the same code on every start. */
async function loop(run: DurableRun, model: MockLanguageModelV4, tools: Record<string, any>, extra: Record<string, unknown> = {}) {
  const result = await generateText({
    model: run.model(model),
    tools: run.tools(tools, (extra.toolOpts as any) ?? {}),
    stopWhen: stepCountIs(6),
    prompt: 'refund order 7',
    maxRetries: 2,
  })
  return result
}

test('canonical matches the shared vectors', () => {
  const file = JSON.parse(readFileSync(new URL('./canonical-vectors.json', import.meta.url), 'utf8'))
  assert.ok(file.vectors.length > 5)
  for (const v of file.vectors) {
    const out = canonical(v.input)
    assert.equal(out, v.output, v.name)
    assert.equal(sha256(out), v.sha256, v.name)
  }
})

test('replay: a finished run is served from the record with no provider call and no tool run', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'refund', { amount: 5 }]), textStep('done')]
  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, { ok: true }) })

  const m1 = provider(script)
  const r1 = await open('o1')
  const first = await loop(r1, m1, { refund })
  assert.equal(first.text, 'done')
  assert.equal(m1.doGenerateCalls.length, 2)
  assert.equal(runs, 1)
  assert.deepEqual(server.events('refunds', 'o1').map((e) => e.kind).slice(1), [
    'loop.model_step', 'loop.tool_started', 'loop.tool_finished', 'loop.model_step',
  ])

  const m2 = provider(script)
  const r2 = await open('o1')
  const writesBefore = server.writes.length
  const second = await loop(r2, m2, { refund })
  assert.equal(second.text, 'done')
  assert.equal(m2.doGenerateCalls.length, 0)
  assert.equal(runs, 1)
  assert.equal(server.writes.length, writesBefore, 'replaying a finished prefix writes nothing')
})

test('divergence: a changed request throws and writes nothing', async () => {
  const { server, open } = setup()
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => 1 })
  const r1 = await open('d1')
  await generateText({ model: r1.model(provider([textStep('hi')])), prompt: 'one', tools: r1.tools({ refund }) })
  const writes = server.writes.length
  const events = server.events('refunds', 'd1').length

  const r2 = await open('d1')
  const m = provider([textStep('hi')])
  await assert.rejects(
    generateText({ model: r2.model(m), prompt: 'two', tools: r2.tools({ refund }), maxRetries: 0 }),
    (e: any) => e instanceof ArgenticDivergence && e.step === 0 && e.recordedHash !== e.requestHash,
  )
  assert.equal(m.doGenerateCalls.length, 0)
  assert.equal(server.writes.length, writes)
  assert.equal(server.events('refunds', 'd1').length, events + 1, 'only the new run_started')
})

/** Run until the named tool is entered, then abandon the process: the tool never returns. */
async function killInTool(server: FakeServer, open: ReturnType<typeof setup>['open'], runId: string, script: any[], opts: Record<string, unknown> = {}) {
  let entered!: () => void
  const wasEntered = new Promise<void>((r) => (entered = r))
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (entered(), new Promise(() => {})) })
  const run = await open(runId, opts)
  void loop(run, provider(script), { refund }).catch(() => {})
  await wasEntered
  assert.equal(server.events('refunds', runId, 'loop.tool_started').length, 1)
  assert.equal(server.events('refunds', runId, 'loop.tool_finished').length, 0)
}

test('killed after tool_started: stop writes tool_unknown and throws ArgenticUnknownOutcome', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'refund', { amount: 5 }]), textStep('done')]
  await killInTool(server, open, 'k1', script)

  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, 'x') })
  const run = await open('k1')
  const m = provider(script)
  await assert.rejects(loop(run, m, { refund }), (e: any) => e instanceof ArgenticUnknownOutcome && e.keys.join() === 'm0.t0')
  assert.equal(runs, 0)
  assert.equal(m.doGenerateCalls.length, 0)
  assert.equal(server.events('refunds', 'k1', 'loop.tool_unknown').length, 1)
  await assert.rejects(run.finish({ reply: 'x' }), ArgenticUnknownOutcome)

  // The app settles it, then the run goes on with the recorded result and does not rerun the tool.
  const run3 = await open('k1')
  await run3.resolve('refunds:k1:m0.t0', { refunded: true })
  const done = await loop(run3, provider([textStep('done')]), { refund }) // m0 is recorded; only m1 is live
  assert.equal(done.text, 'done')
  assert.equal(runs, 0)
  assert.equal(server.events('refunds', 'k1', 'loop.tool_resolved').length, 1)
})

test('killed after tool_started: tell_model returns { status: "unknown" } to the model', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'refund', { amount: 5 }]), textStep('done')]
  await killInTool(server, open, 'k2', script)

  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, 'x') })
  const run = await open('k2', { onUnknown: 'tell_model' })
  const m = provider([textStep('done')])
  const res = await generateText({ model: run.model(m), tools: run.tools({ refund }), stopWhen: stepCountIs(6), prompt: 'refund order 7' })
  void res
  assert.equal(runs, 0)
  // Step 1 is replayed (the recorded script's first reply is the tool call), so the provider only sees the second call.
  const sent = JSON.stringify(m.doGenerateCalls.at(-1)?.prompt)
  assert.match(sent, /unknown/)
  assert.equal(server.events('refunds', 'k2', 'loop.tool_unknown').length, 1)
})

test('dedupesOnKey: a started-not-finished tool runs again under the same key', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'refund', { amount: 5 }]), textStep('done')]
  await killInTool(server, open, 'k3', script)

  const keys: string[] = []
  const run = await open('k3')
  const refund = tool({
    description: 'refund',
    inputSchema: input,
    execute: async (_i: any, o: any) => (keys.push(run.keyFor(o.toolCallId)), { ok: true }),
  })
  const done = await loop(run, provider([textStep('done')]), { refund }, { toolOpts: { dedupesOnKey: ['refund'] } })
  assert.equal(done.text, 'done')
  assert.deepEqual(keys, ['refunds:k3:m0.t0'])
  assert.equal(server.events('refunds', 'k3', 'loop.tool_started').length, 1, 'the claim is not written twice')
  assert.equal(server.events('refunds', 'k3', 'loop.tool_finished').length, 1)
})

test('finished tools are not rerun, recorded errors are rethrown', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'ok', {}], ['c2', 'bad', {}]), textStep('done')]
  let okRuns = 0
  let badRuns = 0
  const ok = tool({ description: 'ok', inputSchema: input, execute: async () => (okRuns++, { v: 1 }) })
  const bad = tool({ description: 'bad', inputSchema: input, execute: async () => (badRuns++, Promise.reject(new Error('nope'))) })
  const r1 = await open('f1')
  const first = await loop(r1, provider(script), { ok, bad })
  assert.equal(okRuns, 1)
  assert.equal(badRuns, 1)
  const fin = server.events('refunds', 'f1', 'loop.tool_finished')
  assert.deepEqual(fin.map((e) => [e.payload.key, e.payload.outcome]).sort(), [['m0.t0', 'ok'], ['m0.t1', 'error']])

  const m2 = provider(script)
  const second = await loop(await open('f1'), m2, { ok, bad })
  assert.equal(okRuns, 1)
  assert.equal(badRuns, 1)
  assert.equal(m2.doGenerateCalls.length, 0)
  assert.equal(second.text, first.text)
})

test('streamText holds tool-call parts until model_step is acked, and text goes through live', async () => {
  const { server, open } = setup()
  const order: string[] = []
  const inner = server.fetch
  server.fetch = async (url: any, init?: any) => {
    const res = await inner(url, init)
    if (init?.body) {
      const b = JSON.parse(init.body)
      for (const e of b.events ?? []) order.push(`ack:${e.type}`)
    }
    return res
  }
  const { client } = (() => ({ client: new Argentic({ apiKey: 'aek_t', baseUrl: 'http://argentic.test', fetch: server.fetch as any, sleep: async () => {} }) }))()
  const run = await durableRun(client, { agent: 'refunds', runId: 's1' })

  const refund = tool({
    description: 'refund',
    inputSchema: input,
    execute: async () => (order.push('tool:execute'), { ok: true }),
  })
  const script = [
    { ...callStep(['c1', 'refund', { amount: 1 }]), content: [{ type: 'text', text: 'working' }, ...callStep(['c1', 'refund', { amount: 1 }]).content] },
    textStep('all done'),
  ]
  const result = streamText({ model: run.model(provider(script)), tools: run.tools({ refund }), stopWhen: stepCountIs(4), prompt: 'go' })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') order.push(`part:text:${(part as any).text ?? (part as any).delta}`)
    if (part.type === 'tool-input-start') order.push('part:tool-input-start')
    if (part.type === 'tool-call') order.push('part:tool-call')
  }
  assert.equal(await result.text, 'all done')
  const firstStepAck = order.indexOf('ack:model_step')
  assert.ok(firstStepAck >= 0)
  assert.ok(order.indexOf('part:text:working') >= 0 && order.indexOf('part:text:working') < firstStepAck, `text is live: ${order}`)
  assert.ok(order.indexOf('part:tool-input-start') > firstStepAck, `tool parts wait for the ack: ${order}`)
  assert.ok(order.indexOf('part:tool-call') > firstStepAck)
  assert.ok(order.indexOf('tool:execute') > order.indexOf('ack:tool_started'))
  assert.ok(order.indexOf('ack:tool_started') > firstStepAck)

  // The streamed run replays as a stream, with no provider call.
  const m2 = provider(script)
  const run2 = await durableRun(client, { agent: 'refunds', runId: 's1' })
  const again = streamText({ model: run2.model(m2), tools: run2.tools({ refund }), stopWhen: stepCountIs(4), prompt: 'go' })
  assert.equal(await again.text, 'all done')
  assert.equal(m2.doStreamCalls.length, 0)
})

test('a provider 429 retried by maxRetries takes no position: replay keeps m0, m1', async () => {
  const { server, open } = setup()
  let attempts = 0
  const flaky = new MockLanguageModelV4({
    doGenerate: async () => {
      attempts++
      if (attempts === 1) {
        throw new APICallError({
          message: 'rate limited', url: 'http://p', requestBodyValues: {}, statusCode: 429, isRetryable: true,
          responseHeaders: { 'retry-after-ms': '1' },
        })
      }
      return attempts === 2 ? callStep(['c1', 'refund', {}]) : textStep('done')
    },
  })
  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, { ok: 1 }) })
  const r1 = await open('r1')
  const first = await loop(r1, flaky, { refund })
  assert.equal(first.text, 'done')
  assert.equal(attempts, 3)
  assert.deepEqual(server.events('refunds', 'r1', 'loop.model_step').map((e) => e.payload.key), ['m0', 'm1'])
  assert.deepEqual(server.events('refunds', 'r1', 'loop.tool_started').map((e) => e.payload.key), ['m0.t0'])

  const m2 = provider([textStep('unused')])
  const second = await loop(await open('r1'), m2, { refund })
  assert.equal(second.text, 'done')
  assert.equal(m2.doGenerateCalls.length, 0)
  assert.equal(runs, 1)
})

test('a tool returning a Date or undefined fields: live and replayed prompts match, no divergence', async () => {
  const { open } = setup()
  const when = new Date('2026-10-21T10:00:00.000Z')
  const script = [callStep(['c1', 'stamp', {}]), textStep('done')]
  const stamp = tool({ description: 'stamp', inputSchema: input, execute: async () => ({ at: when, none: undefined, n: 1 }) })
  const m1 = provider(script)
  const run1 = await open('t1')
  await loop(run1, m1, { stamp })
  const m2 = provider(script)
  const run2 = await open('t1')
  const res = await loop(run2, m2, { stamp })
  assert.equal(res.text, 'done')
  assert.equal(m2.doGenerateCalls.length, 0)
  // The second prompt the model saw live carries the JSON form.
  assert.match(JSON.stringify(m1.doGenerateCalls[1]!.prompt), /2026-10-21T10:00:00.000Z/)
})

test('an unserialisable tool result fails the call at once', async () => {
  const { server, open } = setup()
  const script = [callStep(['c1', 'big', {}]), textStep('done')]
  const big = tool({ description: 'big', inputSchema: input, execute: async () => ({ n: 10n }) })
  const run = await open('u1')
  await loop(run, provider(script), { big }).catch(() => {})
  const fin = server.events('refunds', 'u1', 'loop.tool_finished')
  assert.equal(fin.length, 1)
  assert.equal(fin[0]!.payload.outcome, 'error')
})

test('a tool call that is in no recorded step is refused (ArgenticUnrecorded)', async () => {
  const { server, open } = setup()
  const run = await open('x1')
  const wrapped = run.tools({ refund: tool({ description: 'r', inputSchema: input, execute: async () => 1 }) })
  await assert.rejects((wrapped.refund as any).execute({}, { toolCallId: 'ghost', messages: [] }), ArgenticUnrecorded)
  assert.equal(server.events('refunds', 'x1', 'loop.tool_started').length, 0)
  assert.throws(() => run.keyFor('ghost'), ArgenticUnrecorded)
})

test('fenced: a second process opening the run stops the first, which writes nothing more', async () => {
  const { server, open } = setup()
  const run1 = await open('z1')
  await open('z1') // another process opens the run
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => assert.fail('must not run') })
  const m = provider([textStep('hi')])
  const writes = server.events('refunds', 'z1').length
  await assert.rejects(
    generateText({ model: run1.model(m), tools: run1.tools({ refund }), prompt: 'go', maxRetries: 0 }),
    ArgenticFenced,
  )
  assert.equal(server.events('refunds', 'z1').length, writes)
  assert.ok(run1.halted instanceof ArgenticFenced)
  await assert.rejects(run1.finish(), ArgenticFenced)
  await assert.rejects(run1.step('t', () => 1), ArgenticFenced)
})

test('spend cap: the crossing step is recorded, its tools do not run', async () => {
  const { server, open } = setup()
  const run = await open('p1', { limits: { max_usd: 0.00001 }, prices: { in: 1000, out: 1000 } })
  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, 1) })
  await assert.rejects(loop(run, provider([callStep(['c1', 'refund', {}]), textStep('x')]), { refund }), ArgenticSpendCap)
  assert.equal(runs, 0)
  assert.equal(server.events('refunds', 'p1', 'loop.model_step').length, 1)
  assert.equal(server.events('refunds', 'p1', 'loop.capped').length, 1)
  assert.equal(server.events('refunds', 'p1', 'loop.tool_started').length, 0)

  // A restart serves the recorded step from memory, and the tool's claim is refused by the server.
  const run2 = await open('p1')
  const m = provider([textStep('x')])
  await assert.rejects(loop(run2, m, { refund }))
  assert.equal(m.doGenerateCalls.length, 0)
  assert.equal(runs, 0)
})

test('writes retry the same body with backoff, then throw without running the tool', async () => {
  const { server, open } = setup()
  const run = await open('w1')
  server.failNext = { status: 503, count: 2 }
  const script = [callStep(['c1', 'refund', {}]), textStep('done')]
  let runs = 0
  const refund = tool({ description: 'refund', inputSchema: input, execute: async () => (runs++, 1) })
  const res = await loop(run, provider(script), { refund })
  assert.equal(res.text, 'done')
  assert.equal(runs, 1)
  assert.equal(server.writes[0].events[0].type, 'model_step')
  assert.deepEqual(server.writes[0], server.writes[1], 'same body resent')

  const run2 = await open('w2')
  server.failNext = { status: 503, count: 1000 }
  await assert.rejects(loop(run2, provider(script), { refund }))
  assert.equal(runs, 1, 'the tool never ran')
})

test('run.step records a non-deterministic read once; run.finish writes run_finished', async () => {
  const { server, open } = setup()
  let reads = 0
  const r1 = await open('q1')
  assert.deepEqual(await r1.step('clock', () => (reads++, { t: 5 })), { t: 5 })
  const r2 = await open('q1')
  assert.deepEqual(await r2.step('clock', () => (reads++, { t: 99 })), { t: 5 })
  assert.equal(reads, 1)
  await r2.finish({ reply: 'bye' })
  assert.equal(server.events('refunds', 'q1', 'loop.run_finished')[0]!.payload.reply, 'bye')
})
