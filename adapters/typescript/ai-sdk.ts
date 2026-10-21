// Vercel AI SDK on-ramp (ai 6 and 7).
//   fromAiSdkTools: your tool() objects become Argentic tools. Only the tools carry over;
//     Argentic runs the loop, not generateText or Agent.
//   durableRun: "keep your loop". generateText / streamText / ToolLoopAgent stay yours; a wrapped model and wrapped
//     tools journal each step to Argentic and serve recorded steps back when the same run restarts.
import { asSchema, wrapLanguageModel, type ToolSet } from 'ai'
import { Argentic, ArgenticError, canonical, sha256, type DurableTool } from './argentic.ts'

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === 'object' && v !== null && Symbol.asyncIterator in v

/** The tool name is the ToolSet key. Async because a JSON schema may be a promise. */
export async function fromAiSdkTools(tools: ToolSet): Promise<DurableTool[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, t]): Promise<DurableTool> => {
      const parameters = (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown>
      return {
        name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters,
        execute: async (args, ctx) => {
          if (!t.execute) return { error: `tool ${name} has no execute function` }
          let out: unknown = await t.execute(args, { toolCallId: ctx.idempotencyKey, messages: [] } as any)
          // A streaming tool yields many values; the last one is its result.
          if (isAsyncIterable(out)) {
            let last: unknown
            for await (const part of out) last = part
            out = last
          }
          return out
        },
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// durableRun: keep your loop

/** Base class of every error the loop wrappers throw on purpose. */
export class ArgenticLoopError extends ArgenticError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body)
    this.name = new.target.name
  }
}

/** A recorded step was reached with a different request. The app's code, or something it read, changed between runs. */
export class ArgenticDivergence extends ArgenticLoopError {
  constructor(readonly step: number, readonly recordedHash: string, readonly requestHash: string) {
    super(`run diverged at model step m${step}: recorded request ${recordedHash}, this request ${requestHash}`)
  }
}

/** Another process opened this run; this one is fenced and runs nothing more. */
export class ArgenticFenced extends ArgenticLoopError {
  constructor(readonly epoch?: number, body?: unknown) {
    super('this process was fenced: another process has opened the run', 409, body)
  }
}

/** The run's spend cap was crossed. The step that crossed it is recorded; its tools do not run. */
export class ArgenticSpendCap extends ArgenticLoopError {
  constructor(readonly spentUsd?: number, readonly maxUsd?: number, body?: unknown) {
    super(`spend cap reached (${spentUsd ?? '?'} of ${maxUsd ?? '?'} USD)`, 402, body)
  }
}

/** A tool ran with a toolCallId that is in no recorded model step of this run (a step skipped the wrapped model). */
export class ArgenticUnrecorded extends ArgenticLoopError {
  constructor(readonly toolCallId: string) {
    super(`tool call ${toolCallId} is in no recorded model step of this run; was the model wrapped with run.model()?`)
  }
}

/** A tool was started and no finish was recorded: it may or may not have happened. Settle it and call run.resolve(key, result). */
export class ArgenticUnknownOutcome extends ArgenticLoopError {
  constructor(readonly keys: string[]) {
    super(`outcome unknown for ${keys.join(', ')}: check your own records, then run.resolve(key, result)`)
  }
}

/** JSON the way a stored record comes back: toJSON applied, undefined dropped, bytes as base64. Throws on cycles and BigInt. */
function jsonValue(v: unknown): unknown {
  const text = JSON.stringify(v, function (this: any, key: string, val: unknown) {
    const raw = this[key]
    return raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : val
  })
  return text === undefined ? null : JSON.parse(text)
}

/** What a tool result or a recorded response becomes on both the live run and every replay, so the prompt is byte-identical. */
const normalise = (v: unknown): any => JSON.parse(canonical(jsonValue(v)))

export type OnUnknown = 'stop' | 'tell_model'

export interface DurableRunOptions {
  agent: string
  /** Chosen by you and kept the same across restarts. */
  runId: string
  limits?: { max_usd?: number }
  /** A tool that was started with no recorded finish: 'stop' (default) throws ArgenticUnknownOutcome, 'tell_model' returns { status: 'unknown' } to the model. */
  onUnknown?: OnUnknown
  /** Names this process in the journal. Default `node:<pid>`. */
  process?: string
  /** USD per million tokens, so the run's spend cap can count the reported usage. */
  prices?: { in: number; out: number }
  /** Longest total wait on retries of one write before the wrapper gives up and throws. Default: the client's writeDeadlineMs (60 s). */
  writeDeadlineMs?: number
}

interface LoopEvent {
  seq: number
  at: string
  kind: string
  payload: any
}

interface StoredResponse {
  content: any[]
  finishReason: unknown
  usage: unknown
  warnings?: unknown[]
  providerMetadata?: unknown
  response?: { id?: string; modelId?: string; timestamp?: string }
}

interface ToolState {
  started?: boolean
  finished?: { outcome: 'ok' | 'error'; result: any }
  unknown?: boolean
  resolved?: { result: any }
}

type Params = Record<string, any>

const HELD = new Set(['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'tool-approval-request', 'finish'])
const PASS_THROUGH_CONTENT = new Set(['tool-call', 'tool-result', 'file', 'reasoning-file', 'source', 'custom', 'tool-approval-request'])

const tokenCount = (v: any): number => (typeof v === 'number' ? v : typeof v?.total === 'number' ? v.total : 0)

/** Builds a step's stored response out of stream parts. */
class StreamRecorder {
  content: any[] = []
  finish?: { finishReason: unknown; usage: unknown; providerMetadata?: unknown }
  warnings: unknown[] = []
  meta?: { id?: string; modelId?: string; timestamp?: unknown }
  failed = false
  private open = new Map<string, any>()

  add(part: any): void {
    switch (part.type) {
      case 'text-start':
      case 'reasoning-start': {
        const block: any = { type: part.type === 'text-start' ? 'text' : 'reasoning', text: '' }
        if (part.providerMetadata) block.providerMetadata = part.providerMetadata
        this.open.set(`${block.type}:${part.id}`, block)
        this.content.push(block)
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const type = part.type === 'text-delta' ? 'text' : 'reasoning'
        let block = this.open.get(`${type}:${part.id}`)
        if (!block) {
          block = { type, text: '' }
          this.open.set(`${type}:${part.id}`, block)
          this.content.push(block)
        }
        block.text += part.delta
        return
      }
      case 'text-end':
      case 'reasoning-end': {
        const block = this.open.get(`${part.type === 'text-end' ? 'text' : 'reasoning'}:${part.id}`)
        if (block) {
          if (part.providerMetadata) block.providerMetadata = part.providerMetadata
          if (part.citations) block.citations = part.citations
        }
        return
      }
      case 'stream-start':
        this.warnings = part.warnings ?? []
        return
      case 'response-metadata':
        this.meta = { id: part.id, modelId: part.modelId, timestamp: part.timestamp }
        return
      case 'finish':
        this.finish = { finishReason: part.finishReason, usage: part.usage, providerMetadata: part.providerMetadata }
        return
      case 'error':
        this.failed = true
        return
      default:
        if (PASS_THROUGH_CONTENT.has(part.type)) this.content.push(part)
    }
  }
}

function storedFromGenerate(r: any): StoredResponse {
  const stored: StoredResponse = {
    content: r.content,
    finishReason: r.finishReason,
    usage: r.usage,
    warnings: r.warnings,
  }
  if (r.providerMetadata) stored.providerMetadata = r.providerMetadata
  if (r.response && (r.response.id || r.response.modelId || r.response.timestamp)) {
    stored.response = { id: r.response.id, modelId: r.response.modelId, timestamp: r.response.timestamp }
  }
  return normalise(stored)
}

function storedFromStream(rec: StreamRecorder): StoredResponse {
  const stored: StoredResponse = {
    content: rec.content,
    finishReason: rec.finish!.finishReason,
    usage: rec.finish!.usage,
    warnings: rec.warnings,
  }
  if (rec.finish!.providerMetadata) stored.providerMetadata = rec.finish!.providerMetadata
  if (rec.meta) stored.response = rec.meta as StoredResponse['response']
  return normalise(stored)
}

function generateResult(stored: StoredResponse): any {
  const out: any = {
    content: stored.content,
    finishReason: stored.finishReason,
    usage: stored.usage,
    warnings: stored.warnings ?? [],
  }
  if (stored.providerMetadata) out.providerMetadata = stored.providerMetadata
  if (stored.response) {
    out.response = { id: stored.response.id, modelId: stored.response.modelId }
    if (stored.response.timestamp) out.response.timestamp = new Date(stored.response.timestamp)
  }
  return out
}

/** A stream that plays a recorded step: the same content, as parts. */
function streamResult(stored: StoredResponse): any {
  const parts: any[] = [{ type: 'stream-start', warnings: stored.warnings ?? [] }]
  if (stored.response) {
    const meta: any = { type: 'response-metadata', id: stored.response.id, modelId: stored.response.modelId }
    if (stored.response.timestamp) meta.timestamp = new Date(stored.response.timestamp)
    parts.push(meta)
  }
  let id = 0
  for (const c of stored.content) {
    if (c.type === 'text' || c.type === 'reasoning') {
      const pid = String(id++)
      const { type, text, ...rest } = c
      parts.push({ type: `${type}-start`, id: pid, ...(rest.providerMetadata ? { providerMetadata: rest.providerMetadata } : {}) })
      if (text) parts.push({ type: `${type}-delta`, id: pid, delta: text })
      parts.push({ type: `${type}-end`, id: pid, ...rest })
    } else {
      parts.push(c)
    }
  }
  const finish: any = { type: 'finish', usage: stored.usage, finishReason: stored.finishReason }
  if (stored.providerMetadata) finish.providerMetadata = stored.providerMetadata
  parts.push(finish)
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p)
        controller.close()
      },
    }),
  }
}

/**
 * One run of your own agent loop, journaled to Argentic. See durableRun.
 *
 * What is covered: model calls made through `run.model()` and tool calls made through `run.tools()`. A tool passed to
 * the SDK without `run.tools()` is not covered: its calls are not recorded, claimed or replayed, and it can repeat.
 * One run is one sequential chain of model calls: `run.child()` is not in phase 1, and two model calls at once on one
 * run take the same position, so the second fails with a divergent write.
 */
export class DurableRun {
  readonly agent: string
  readonly runId: string
  readonly epoch: number
  /** The error that stopped this run (fenced, unknown outcome, spend cap, a write that never landed). Once set, nothing more runs. */
  halted?: Error
  private n = 0
  private lastPrompt?: unknown[]
  private readonly steps = new Map<number, { hash: string; response: StoredResponse }>()
  private readonly calls = new Map<string, { n: number; i: number }>()
  private readonly toolStates = new Map<string, ToolState>()
  private readonly stepResults = new Map<string, unknown>()
  private readonly stepCounters = new Map<string, number>()
  private readonly unknownKeys = new Set<string>()
  private capped = false
  private finished = false

  constructor(
    private readonly client: Argentic,
    private readonly opts: DurableRunOptions,
    epoch: number,
    events: LoopEvent[],
  ) {
    this.agent = opts.agent
    this.runId = opts.runId
    this.epoch = epoch
    let cappedSeq = -1
    let limitsSeq = -1
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      const p = ev.payload ?? {}
      switch (ev.kind) {
        case 'loop.run_started':
          if (p.limits) limitsSeq = ev.seq
          break
        case 'loop.model_step':
          this.steps.set(p.step, { hash: p.request_hash, response: p.response })
          this.indexCalls(p.step, p.response)
          break
        case 'loop.tool_started':
          this.state(p.key).started = true
          break
        case 'loop.tool_finished':
          this.state(p.key).finished = { outcome: p.outcome, result: p.result }
          break
        case 'loop.tool_unknown':
          this.state(p.key).unknown = true
          break
        case 'loop.tool_resolved':
          this.state(p.key).resolved = { result: p.result }
          break
        case 'loop.step_recorded':
          this.stepResults.set(p.key, p.result)
          break
        case 'loop.capped':
          cappedSeq = ev.seq
          break
        case 'loop.run_finished':
          this.finished = true
          break
      }
    }
    // A later open that set new limits lifts an earlier cap.
    this.capped = cappedSeq > limitsSeq
  }

  private state(key: string): ToolState {
    let s = this.toolStates.get(key)
    if (!s) this.toolStates.set(key, (s = {}))
    return s
  }

  private indexCalls(n: number, response: StoredResponse): void {
    let i = 0
    for (const c of response?.content ?? []) {
      if (c.type === 'tool-call') this.calls.set(c.toolCallId, { n, i: i++ })
    }
  }

  /** The key for a tool's own side effect (an Idempotency-Key, a unique column): `<agent>:<run>:m<n>.t<i>`. Pass options.toolCallId. */
  keyFor(toolCallId: string): string {
    const at = this.calls.get(toolCallId)
    if (!at) throw new ArgenticUnrecorded(toolCallId)
    return `${this.agent}:${this.runId}:m${at.n}.t${at.i}`
  }

  private assertRunning(): void {
    if (this.halted) throw this.halted
  }

  private halt<E extends Error>(e: E): E {
    this.halted ??= e
    return e
  }

  /** One write, with retries. Anything that cannot be recorded stops the run: nothing runs on an unrecorded step. */
  private async write(event: Record<string, unknown>): Promise<{ status: string; capped?: boolean; spent_usd?: number }> {
    this.assertRunning()
    const path = `/v1/agents/${encodeURIComponent(this.agent)}/runs/${encodeURIComponent(this.runId)}/events`
    let answer: any
    try {
      answer = await this.client.postJson(path, { epoch: this.epoch, events: [event] }, { deadlineMs: this.opts.writeDeadlineMs })
    } catch (e) {
      throw this.halt(this.mapWriteError(e))
    }
    const r = answer?.results?.[0]
    if (!r) throw this.halt(new ArgenticError('events answer has no result for the write', undefined, answer))
    return { status: r.status, capped: answer.capped, spent_usd: answer.spent_usd }
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof ArgenticError) {
      const body = (e.body ?? {}) as { error?: string; epoch?: number; spent_usd?: number; max_usd?: number }
      if (e.status === 409 && body.error === 'fenced') return new ArgenticFenced(body.epoch, e.body)
      if (e.status === 402 && body.error === 'spend_cap') return new ArgenticSpendCap(body.spent_usd, body.max_usd, e.body)
    }
    return e instanceof Error ? e : new Error(String(e))
  }

  // ---- model ----

  /** The model with recording and replay. Use it wherever the SDK takes a model, including inside an Agent. */
  model(languageModel: Parameters<typeof wrapLanguageModel>[0]['model']): ReturnType<typeof wrapLanguageModel> {
    const middleware = {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params, model }: any) => {
        const begun = this.beginStep(params)
        if (begun.served) return generateResult(begun.served)
        const stored = storedFromGenerate(await doGenerate())
        await this.record(begun, params, model, stored)
        return generateResult(stored)
      },
      wrapStream: async ({ doStream, params, model }: any) => {
        const begun = this.beginStep(params)
        if (begun.served) return streamResult(begun.served)
        const live = await doStream()
        const recorder = new StreamRecorder()
        const held: any[] = []
        let holding = false
        const run = this
        const stream = (live.stream as ReadableStream<any>).pipeThrough(
          new TransformStream<any, any>({
            transform(part, controller) {
              recorder.add(part)
              if (part.type === 'error') {
                controller.enqueue(part)
              } else if (holding || HELD.has(part.type)) {
                holding = true
                held.push(part)
              } else {
                controller.enqueue(part)
              }
            },
            async flush(controller) {
              // A failed or cut-off stream records nothing, and the held tool calls are never released.
              if (recorder.failed) return
              if (!recorder.finish) throw new ArgenticError('the model stream ended without a finish part; nothing was recorded')
              await run.record(begun, params, model, storedFromStream(recorder))
              for (const part of held) controller.enqueue(part)
            },
          }),
        )
        return { ...live, stream }
      },
    }
    return wrapLanguageModel({ model: languageModel, middleware: middleware as any })
  }

  private beginStep(params: Params): { n: number; hash: string; prompt: unknown[]; served?: StoredResponse } {
    this.assertRunning()
    const { abortSignal: _a, headers: _h, ...rest } = params
    const options = jsonValue(rest) as Params
    const hash = sha256(canonical(options))
    const n = this.n
    const prompt = (options.prompt ?? []) as unknown[]
    const rec = this.steps.get(n)
    if (rec) {
      if (rec.hash !== hash) throw this.halt(new ArgenticDivergence(n, rec.hash, hash))
      this.n = n + 1
      this.lastPrompt = prompt
      return { n, hash, prompt, served: rec.response }
    }
    if (this.capped) throw this.halt(new ArgenticSpendCap())
    return { n, hash, prompt }
  }

  /** Write the model_step, and only return once it is acknowledged. */
  private async record(begun: { n: number; hash: string; prompt: unknown[] }, params: Params, model: any, stored: StoredResponse): Promise<void> {
    const prev = this.lastPrompt
    const extends_ =
      prev !== undefined &&
      prev.length <= begun.prompt.length &&
      prev.every((m, j) => canonical(m) === canonical(begun.prompt[j]))
    const messages = extends_ ? begun.prompt.slice(prev!.length) : begun.prompt
    const usage = stored.usage as any
    const event: Record<string, unknown> = {
      type: 'model_step',
      key: `m${begun.n}`,
      step: begun.n,
      request_hash: begun.hash,
      request_delta: { full: !extends_, messages },
      response: stored,
      usage: { input_tokens: tokenCount(usage?.inputTokens), output_tokens: tokenCount(usage?.outputTokens) },
      provider: String(model?.provider ?? 'unknown'),
      model_id: String(model?.modelId ?? 'unknown'),
    }
    if (this.opts.prices) event.prices = this.opts.prices
    const ack = await this.write(event)
    this.steps.set(begun.n, { hash: begun.hash, response: stored })
    this.indexCalls(begun.n, stored)
    this.n = begun.n + 1
    this.lastPrompt = begun.prompt
    if (ack.capped) {
      this.capped = true
      throw this.halt(new ArgenticSpendCap(ack.spent_usd, this.opts.limits?.max_usd))
    }
  }

  // ---- tools ----

  /**
   * Wrap every tool that has an `execute`. Tools without one (answered by the client) are left alone.
   * `dedupesOnKey`: names of tools that pass run.keyFor(toolCallId) to something that refuses a repeat, so a tool
   * that was started and never finished is safe to run again under the same key.
   *
   * The SDK turns an error thrown by `execute` into a tool-error result and carries on, so a stop (fenced, unknown
   * outcome, spend cap, a write that never landed) is remembered on the run: the next model call and run.finish() throw it.
   */
  tools<T extends ToolSet>(toolSet: T, opts: { dedupesOnKey?: string[] } = {}): T {
    const dedupes = new Set(opts.dedupesOnKey ?? [])
    const out: Record<string, unknown> = {}
    for (const [name, t] of Object.entries(toolSet)) {
      const original = (t as any).execute
      out[name] =
        typeof original === 'function'
          ? { ...t, execute: (input: unknown, options: any) => this.runTool(name, input, options, () => original.call(t, input, options), dedupes.has(name)) }
          : t
    }
    return out as T
  }

  private async runTool(name: string, input: unknown, options: any, execute: () => unknown, dedupes: boolean): Promise<unknown> {
    this.assertRunning()
    const toolCallId = options?.toolCallId as string
    const at = this.calls.get(toolCallId)
    if (!at) throw this.halt(new ArgenticUnrecorded(String(toolCallId)))
    const key = `m${at.n}.t${at.i}`
    const st = this.state(key)

    if (st.finished) {
      if (st.finished.outcome === 'error') throw recordedError(st.finished.result)
      return st.finished.result
    }
    if (st.resolved) return st.resolved.result

    let mustRun = false
    if (st.started || st.unknown) {
      if (!dedupes) return this.unknown(key, st)
      mustRun = true
    }
    if (!mustRun) {
      const ack = await this.write({ type: 'tool_started', key, tool: name, args_hash: sha256(canonical(jsonValue(input))) })
      st.started = true
      if (ack.status === 'existed' && !dedupes) return this.unknown(key, st)
    }

    let raw: unknown
    try {
      raw = await execute()
      // A streaming tool yields many values; the last one is its result.
      if (isAsyncIterable(raw)) {
        let last: unknown
        for await (const part of raw) last = part
        raw = last
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const result = { message, name: e instanceof Error ? e.name : 'Error' }
      await this.finishTool(key, st, 'error', result)
      throw e
    }
    let result: unknown
    try {
      result = normalise(raw)
    } catch (e) {
      const message = `tool ${name} returned a value that cannot be recorded as JSON: ${e instanceof Error ? e.message : String(e)}`
      await this.finishTool(key, st, 'error', { message, name: 'Error' })
      throw new Error(message)
    }
    await this.finishTool(key, st, 'ok', result)
    return result
  }

  private async finishTool(key: string, st: ToolState, outcome: 'ok' | 'error', result: unknown): Promise<void> {
    await this.write({ type: 'tool_finished', key, outcome, result, result_hash: sha256(canonical(result)) })
    st.finished = { outcome, result }
  }

  private async unknown(key: string, st: ToolState): Promise<unknown> {
    if (!st.unknown) {
      await this.write({ type: 'tool_unknown', key })
      st.unknown = true
    }
    this.unknownKeys.add(key)
    if ((this.opts.onUnknown ?? 'stop') === 'tell_model') return { status: 'unknown' }
    throw this.halt(new ArgenticUnknownOutcome([...this.unknownKeys]))
  }

  /** After you checked your own records for an unknown tool call: record what happened, so the run goes on with this result. */
  async resolve(key: string, result: unknown): Promise<void> {
    const bare = key.startsWith(`${this.agent}:${this.runId}:`) ? key.slice(`${this.agent}:${this.runId}:`.length) : key
    const value = normalise(result)
    await this.write({ type: 'tool_resolved', key: bare, result: value })
    this.state(bare).resolved = { result: value }
    this.unknownKeys.delete(bare)
    if (this.halted instanceof ArgenticUnknownOutcome && this.unknownKeys.size === 0) this.halted = undefined
  }

  // ---- steps and finish ----

  /** Run a non-deterministic read (a clock, a random number, a database lookup) once; a restart gets the recorded value back. */
  async step<R>(name: string, fn: () => R | Promise<R>): Promise<R> {
    this.assertRunning()
    const k = this.stepCounters.get(name) ?? 0
    this.stepCounters.set(name, k + 1)
    const key = `s:${name}#${k}`
    if (this.stepResults.has(key)) return this.stepResults.get(key) as R
    const result = normalise(await fn())
    await this.write({ type: 'step_recorded', key, result })
    this.stepResults.set(key, result)
    return result as R
  }

  /** Mark the run done. Also the place a stop that happened inside a tool surfaces if the SDK swallowed it. */
  async finish(opts: { reply?: string } = {}): Promise<void> {
    this.assertRunning()
    const event: Record<string, unknown> = { type: 'run_finished', key: 'run' }
    if (opts.reply !== undefined) event.reply = opts.reply
    await this.write(event)
    this.finished = true
  }
}

function recordedError(result: any): Error {
  const e = new Error(result?.message ?? 'tool failed')
  if (result?.name) e.name = result.name
  return e
}

/**
 * Keep your loop: run generateText, streamText or a ToolLoopAgent yourself, and journal its steps to Argentic.
 * Opens the run (one POST) and holds its recorded events in memory, so replaying a finished prefix costs no round trips.
 *
 *   const run = await durableRun(client, { agent: 'refunds', runId: order.id })
 *   const result = await generateText({
 *     model: run.model(openai('gpt-5.1')),
 *     tools: run.tools({ refund, email }, { dedupesOnKey: ['refund'] }),
 *     stopWhen: stepCountIs(10),
 *     prompt,
 *   })
 *   await run.finish({ reply: result.text })
 *
 * Restart the same code with the same runId after a crash. A finished action is not started again; an action cut off
 * mid-call is retried under its own key (dedupesOnKey) or stopped for you to settle. Not "exactly once": a side effect
 * outside a wrapped tool, or a tool that ignores its key, can still repeat. Argentic's availability becomes a
 * dependency of the run: a write that cannot land within the deadline throws, and nothing runs on it.
 */
export async function durableRun(client: Argentic, opts: DurableRunOptions): Promise<DurableRun> {
  const body: Record<string, unknown> = { process: (opts.process ?? `node:${process.pid}`).slice(0, 64) }
  if (opts.limits) body.limits = opts.limits
  const path = `/v1/agents/${encodeURIComponent(opts.agent)}/runs/${encodeURIComponent(opts.runId)}/open`
  const answer = await client.postJson(path, body, { deadlineMs: opts.writeDeadlineMs })
  if (typeof answer?.epoch !== 'number' || !Array.isArray(answer.events)) {
    throw new ArgenticError('open answered without an epoch and events', undefined, answer)
  }
  return new DurableRun(client, opts, answer.epoch, answer.events)
}
