// The agent under test: one durable run of an AI SDK loop with two tools. Spawned by kill.ts as a child process
// (config in KT_CFG, JSON), killed by the parent with SIGKILL at a named point, and started again with the same runId.
//
//   lookup  read-only
//   charge  a side effect: appends `<argentic key>\t<amount>` to the ledger file. The ledger is the ground truth for duplicates.
//           With cfg.dedupes the tool also refuses a key that is already in the ledger (a key-deduping charge).
//
// Protocol with the parent, on stdout: `@@AT <point>` when paused (the parent then SIGKILLs us, or writes a line to our stdin to
// release us), `@@CHARGE wrote|refused <key>` per charge call, `@@DONE <json>` at the end.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { APICallError, generateText, jsonSchema, stepCountIs, streamText, tool as aiTool, wrapLanguageModel } from 'ai'
import * as aiTest from 'ai/test'
import { Argentic } from '../../argentic.ts'
import { durableRun } from '../../ai-sdk.ts'

export interface Cfg {
  agent: string
  runId: string
  ledger: string
  mode: 'scripted' | 'live'
  stream: boolean
  /** charge is in dedupesOnKey, and the charge tool refuses a key already in the ledger. */
  dedupes: boolean
  onUnknown?: 'stop' | 'tell_model'
  /** Pause (and wait for SIGKILL or a line on stdin) at this point. */
  pauseAt?:
    | 'charge_entry' // tool_started acknowledged, side effect not yet done
    | 'charge_done' // side effect done, tool_finished not yet written
    | 'before_model_after_charge' // tool_finished acknowledged, the next model call not yet made
    | 'before_model_after_lookup'
    | 'stream_charge_part' // the charge tool-call part arrived from the provider, the step is not recorded
    | 'charge_call_received' // generate: the provider answered with the charge call, the step is not recorded
  /** Fail the first provider attempt made after `afterTools` tool results are in the prompt. */
  fail?: { afterTools: number; status: number; via: 'throw' | 'fetch' }
  lookupDate?: boolean
  throttleFile?: string
  liveBudget?: number
  modelId?: string
}

const cfg: Cfg = JSON.parse(process.env.KT_CFG!)
const out = (s: string) => process.stdout.write(s + '\n')
const stats = { providerAttempts: 0, toolRuns: { lookup: 0, charge: 0 }, charges: [] as string[], writes: [] as { kind: string; ms: number }[] }

async function pause(name: string): Promise<void> {
  if (cfg.pauseAt !== name) return
  out(`@@AT ${name}`)
  await new Promise<void>((res) => process.stdin.once('data', () => res()))
}

const ledgerHas = (key: string) => existsSync(cfg.ledger) && readFileSync(cfg.ledger, 'utf8').split('\n').some((l) => l.split('\t')[0] === key)

// ---- the prompt, as the model sees it: which tools have answered so far
const toolsDone = (prompt: any[]): string[] =>
  prompt.filter((m) => m.role === 'tool').flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolName))

// ---- the scripted provider: stateless, so a restarted process plays the same story
const { MockLanguageModelV4 } = aiTest as any
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
function scriptedStep(prompt: any[]) {
  const done = toolsDone(prompt).length
  const call = (id: string, name: string, input: unknown) => ({
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
    usage,
    warnings: [],
  })
  if (done === 0) return call('call_lookup', 'lookup', { customer: 'acme' })
  if (done === 1) return call('call_charge', 'charge', { amount: 5 })
  return { content: [{ type: 'text' as const, text: 'Charged acme 5 once. Done.' }], finishReason: { unified: 'stop', raw: 'stop' } as const, usage, warnings: [] }
}
function scriptedModel() {
  return new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-1',
    doGenerate: async (o: any) => scriptedStep(o.prompt),
    doStream: async (o: any) => {
      const step = scriptedStep(o.prompt)
      const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
      for (const c of step.content as any[]) {
        if (c.type === 'text') chunks.push({ type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: c.text }, { type: 'text-end', id: '0' })
        else chunks.push({ type: 'tool-input-start', id: c.toolCallId, toolName: c.toolName }, { type: 'tool-input-delta', id: c.toolCallId, delta: c.input }, { type: 'tool-input-end', id: c.toolCallId }, c)
      }
      chunks.push({ type: 'finish', finishReason: step.finishReason, usage: step.usage })
      return { stream: (aiTest as any).simulateReadableStream({ chunks }) }
    },
  })
}

// ---- a scripted provider behind a real provider package, with a fetch that answers 429 once (cfg.fail.via === 'fetch')
async function fetchModel() {
  const mod = '@ai-sdk/openai-compatible'
  const { createOpenAICompatible } = (await import(mod)) as any
  let failed = false
  const stub = async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    const done = body.messages.filter((m: any) => m.role === 'tool').length
    if (!failed && cfg.fail && done === cfg.fail.afterTools) {
      failed = true
      out(`@@FAIL injected ${cfg.fail.status} (fetch)`)
      return new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }), { status: cfg.fail.status, headers: { 'content-type': 'application/json', 'retry-after-ms': '200' } })
    }
    const message =
      done === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"customer":"acme"}' } }] }
      : done === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_charge', type: 'function', function: { name: 'charge', arguments: '{"amount":5}' } }] }
      : { role: 'assistant', content: 'Charged acme 5 once. Done.' }
    const finish_reason = done < 2 ? 'tool_calls' : 'stop'
    return new Response(JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion', created: 0, model: 'stub-model', choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return createOpenAICompatible({ name: 'stub', baseURL: 'http://stub.invalid/v1', apiKey: 'x', fetch: stub }).chatModel('stub-model')
}

async function liveModel() {
  const mod = '@ai-sdk/openai-compatible'
  const { createOpenAICompatible } = (await import(mod)) as any
  return createOpenAICompatible({ name: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NV_API_KEY! }).chatModel(cfg.modelId ?? 'nvidia/nemotron-3.5-lightning-30b-a3b')
}

// ---- live throttle: one request in flight, 2 s between calls, a hard budget, shared across processes through a file
type Throttle = { last: number; count: number }
const readThrottle = (): Throttle => (existsSync(cfg.throttleFile!) ? JSON.parse(readFileSync(cfg.throttleFile!, 'utf8')) : { last: 0, count: 0 })
async function liveGate(): Promise<void> {
  const t = readThrottle()
  if (t.count >= (cfg.liveBudget ?? 60)) throw new Error(`live call budget of ${cfg.liveBudget ?? 60} exhausted`)
  const wait = t.last + 2000 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  t.count++
  writeFileSync(cfg.throttleFile!, JSON.stringify(t))
}
const liveDone = () => {
  const t = readThrottle()
  t.last = Date.now()
  writeFileSync(cfg.throttleFile!, JSON.stringify(t))
}

/** Live only: a 429 from the shared key is waited out here (15, 30, 60, 90 s), each attempt throttled and counted, so the SDK's own 2 s retries do not hammer it. */
async function liveRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    await liveGate()
    try {
      return await call()
    } catch (e: any) {
      liveDone()
      if (e?.statusCode !== 429 || i >= 4) throw e
      const wait = [15, 30, 60, 90][i]! * 1000
      out(`@@BACKOFF 429 from the provider, waiting ${wait / 1000} s`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

/** Sits between the Argentic wrapper and the provider: counts the calls that actually reach it, throttles, injects faults, pauses. */
function spy(base: any) {
  const gate = async (params: any) => {
    const done = toolsDone(params.prompt)
    if (done.at(-1) === 'charge') await pause('before_model_after_charge')
    if (done.at(-1) === 'lookup') await pause('before_model_after_lookup')
    stats.providerAttempts++
    if (cfg.fail?.via === 'throw' && !(globalThis as any).__failed && done.length === cfg.fail.afterTools) {
      ;(globalThis as any).__failed = true
      out(`@@FAIL injected ${cfg.fail.status} (throw)`)
      throw new APICallError({ message: `injected ${cfg.fail.status}`, url: 'http://provider.invalid/chat', requestBodyValues: {}, statusCode: cfg.fail.status, responseHeaders: { 'retry-after-ms': '200' }, isRetryable: true })
    }
  }
  const hasCharge = (content: any[]) => content.some((c) => c.type === 'tool-call' && c.toolName === 'charge')
  return wrapLanguageModel({
    model: base,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }: any) => {
        await gate(params)
        const r = cfg.mode === 'live' ? await liveRetry(doGenerate) : await doGenerate()
        if (cfg.mode === 'live') liveDone()
        if (hasCharge(r.content)) await pause('charge_call_received')
        return r
      },
      wrapStream: async ({ doStream, params }: any) => {
        await gate(params)
        const r = cfg.mode === 'live' ? await liveRetry(doStream) : await doStream()
        const stream = (r.stream as ReadableStream<any>).pipeThrough(
          new TransformStream<any, any>({
            async transform(part, controller) {
              if (part.type === 'tool-call' && part.toolName === 'charge') await pause('stream_charge_part')
              controller.enqueue(part)
            },
            flush() {
              if (cfg.mode === 'live') liveDone()
            },
          }),
        )
        return { ...r, stream }
      },
    } as any,
  })
}

// ---- timed fetch: every write the client makes to Argentic, with its round trip
const timedFetch: typeof fetch = async (url, init) => {
  const t0 = performance.now()
  const res = await fetch(url, init)
  const path = String(url)
  if (init?.method === 'POST' && /\/runs\/[^/]+\/(open|events)$/.test(path)) {
    let kind = 'open'
    if (path.endsWith('/events')) kind = JSON.parse(String(init.body)).events[0].type
    stats.writes.push({ kind: res.ok ? kind : `${kind}:${res.status}`, ms: performance.now() - t0 })
  }
  return res
}

const SYSTEM = 'You are a billing agent. Call exactly one tool per step, never two tools in the same step. Do not repeat a tool call.'
const PROMPT = "Look up the customer 'acme' with the lookup tool. After you have its result, charge them 5 dollars once with the charge tool. Then reply with one short sentence confirming."

async function main() {
  const client = new Argentic({ apiKey: process.env.ARGENTIC_API_KEY!, baseUrl: process.env.ARGENTIC_BASE_URL!, fetch: timedFetch, writeDeadlineMs: 20_000 })
  const run = await durableRun(client, { agent: cfg.agent, runId: cfg.runId, process: `kt:${process.pid}`, ...(cfg.onUnknown ? { onUnknown: cfg.onUnknown } : {}) })
  const lookup = aiTool({
    description: 'Look up a customer. Read-only.',
    inputSchema: jsonSchema<{ customer: string }>({ type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }),
    execute: async (input: any) => {
      stats.toolRuns.lookup++
      return { customer: input.customer, plan: 'pro', since: cfg.lookupDate ? new Date('2024-01-02T03:04:05.000Z') : '2024-01-02T03:04:05.000Z' }
    },
  } as any)
  const charge = aiTool({
    description: 'Charge the customer an amount in dollars. Has a side effect: call it once.',
    inputSchema: jsonSchema<{ amount: number }>({ type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] }),
    execute: async (input: any, options: any) => {
      const key = run.keyFor(options.toolCallId)
      stats.toolRuns.charge++
      await pause('charge_entry')
      if (cfg.dedupes && ledgerHas(key)) {
        out(`@@CHARGE refused ${key}`)
        stats.charges.push(`refused ${key}`)
        return { status: 'already_charged', key }
      }
      appendFileSync(cfg.ledger, `${key}\t${input.amount}\n`)
      out(`@@CHARGE wrote ${key}`)
      stats.charges.push(`wrote ${key}`)
      await pause('charge_done')
      return { status: 'charged', key }
    },
  } as any)

  const base = cfg.mode === 'live' ? await liveModel() : cfg.fail?.via === 'fetch' ? await fetchModel() : scriptedModel()
  const common: any = {
    model: run.model(spy(base)),
    tools: run.tools({ lookup, charge }, { dedupesOnKey: cfg.dedupes ? ['charge'] : [] }),
    stopWhen: stepCountIs(6),
    system: SYSTEM,
    prompt: PROMPT,
    maxRetries: 2,
    ...(cfg.mode === 'live' ? { temperature: 0 } : {}),
  }
  let text: string
  if (cfg.stream) {
    const errors: unknown[] = []
    const r = streamText({ ...common, onError: ({ error }: any) => errors.push(error) })
    text = await Promise.resolve(r.text).catch((e: unknown) => {
      errors.push(e)
      return ''
    })
    if (errors.length) throw run.halted ?? errors[0]
  } else {
    text = (await generateText(common)).text
  }
  await run.finish({ reply: text })
  return text
}

let result: any
try {
  const text = await main()
  result = { ok: true, text }
} catch (e: any) {
  const msg = String(e?.message ?? e).replaceAll(process.env.NV_API_KEY ?? '\u0000', '***')
  result = { ok: false, error: { name: e?.name, message: msg.slice(0, 400), status: e?.status } }
}
out(`@@DONE ${JSON.stringify({ ...result, stats })}`)
process.exit(result.ok ? 0 : 3)
