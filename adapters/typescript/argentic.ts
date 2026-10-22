// Argentic core: a small client and a durable tool loop. No dependencies, Node 22+.
// Argentic runs the agent loop; your code carries out the tool calls it asks for.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const defaultBaseUrl = 'https://api.getargentic.com'

/** A wake can run a long time, so a try waits five minutes, as Python's client does. */
export const defaultTimeoutMs = 300_000

export interface ModelSpec {
  provider: string
  id: string
  prices: { in: number; out: number }
}

/** The free default model. */
export const freeModel: ModelSpec = {
  provider: 'nvidia',
  id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  prices: { in: 0, out: 0 },
}

/** What Argentic is told about a tool. It is declared, never executed by Argentic. */
export interface ToolDecl {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const propKeys = ['type', 'description', 'enum'] as const

/**
 * Trim a JSON schema to the subset Argentic accepts: an object of string, number,
 * integer, boolean or array-of-those properties, with description, enum and required.
 * Framework extras ($schema, additionalProperties, title, defaults) are dropped.
 */
export function toArgenticSchema(schema: Record<string, any>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [name, prop] of Object.entries<Record<string, any>>(schema?.properties ?? {})) {
    const out: Record<string, unknown> = {}
    for (const k of propKeys) if (prop[k] !== undefined) out[k] = prop[k]
    if (prop.type === 'array' && prop.items?.type) out.items = { type: prop.items.type }
    properties[name] = out
  }
  const result: Record<string, unknown> = { type: 'object', properties }
  if (Array.isArray(schema?.required) && schema.required.length) result.required = schema.required
  return result
}

export interface WakeBody {
  /** Required unless `fire_due` is set; the API refuses both together. */
  message?: string
  /** Wake for the plans, schedules and timers that have fallen due instead of with a message. */
  fire_due?: boolean
  /** Which memory of the agent to wake. Left out, the agent's default. */
  memory?: string
  model: ModelSpec
  system?: string
  tools?: ToolDecl[]
  limits?: { max_usd?: number; max_turns?: number }
}

export interface Action {
  id: string
  tool: string
  args: Record<string, unknown>
  seq: number
}

export type WakeStatus = 'done' | 'spend_cap' | 'budget_cap' | 'turn_cap' | 'time_cap' | 'error' | 'approval_required'

export interface WakeResult {
  status: WakeStatus
  reply: string
  spent_usd: number
  turns: number
  wake_id: string
  actions?: Action[]
  resumed?: boolean
  error?: string
  /** True when this key was already answered and the stored answer came back. */
  idempotentReplay: boolean
}

export interface ReplayTurn {
  turn_seq: number
  wake_id: string | null
  match: boolean | null
  reason?: string
}

export interface ReplayResult {
  turns: ReplayTurn[]
  matched: number
  mismatched: number
  unverifiable: number
  [key: string]: unknown
}

export class ArgenticError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message)
    this.name = 'ArgenticError'
  }
}

/** A next step for an error a first run tends to hit, or undefined. Examples print it instead of a stack trace. */
export function hintFor(e: unknown): string | undefined {
  if (!(e instanceof ArgenticError)) return undefined
  const code = (e.body as { error?: string } | undefined)?.error
  if (e.status === 401) return 'Check ARGENTIC_API_KEY. A key only works on the API it was made for, so if you set ARGENTIC_BASE_URL, make the key in that dashboard.'
  if (code === 'model_key_rejected') return 'Your model provider refused MODEL_KEY. Check it is a key for the provider in the error (a free NVIDIA key starts with nvapi-).'
  if (code === 'bad_model') return 'Your provider does not know this model id. Set ARGENTIC_MODEL_ID to one it serves, or unset it for the free default.'
  if (e.status === 402) return 'This account hit its usage limit. Argentic is free in beta, so there is nothing to buy: email hi@getargentic.com and we will raise it.'
  if (e.status === 429) return 'Too many requests a minute for this key. Wait for the time in the error and run the same command again.'
  if (e.status === undefined || e.status >= 500) return 'The API did not answer. Run the same command again in a minute: it picks up where it stopped.'
  return undefined
}

export interface ClientOptions {
  /** Defaults to the ARGENTIC_API_KEY environment variable. */
  apiKey?: string
  /** Sent as X-Model-Key on wake. Defaults to the MODEL_KEY environment variable. */
  modelKey?: string
  baseUrl?: string
  /** How long one request may take before that try counts as a network failure, in milliseconds. Default 300000; 0 means no limit. */
  timeoutMs?: number
  fetch?: typeof fetch
  /** Waits between retries of a 5xx or network failure. */
  backoffMs?: number[]
  /** Upper bound on 409 queued retries before giving up. */
  maxQueuedWaits?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class Argentic {
  private readonly apiKey: string
  private readonly modelKey?: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly doFetch: typeof fetch
  private readonly backoffMs: number[]
  private readonly maxQueuedWaits: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ARGENTIC_API_KEY ?? ''
    this.modelKey = opts.modelKey || process.env.MODEL_KEY || undefined
    this.timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
    this.baseUrl = (opts.baseUrl ?? process.env.ARGENTIC_BASE_URL ?? defaultBaseUrl).replace(/\/+$/, '')
    this.doFetch = opts.fetch ?? fetch
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000, 8000]
    this.maxQueuedWaits = opts.maxQueuedWaits ?? 60
    this.sleep = opts.sleep ?? wait
  }

  /**
   * Wake an agent with a message. Safe to call again with the same key:
   * a queued (409) answer waits and resends, a 5xx or network error retries
   * with backoff, and a reused key with a different body throws.
   */
  async wake(agent: string, body: WakeBody, idempotencyKey: string): Promise<WakeResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    }
    if (this.modelKey) headers['X-Model-Key'] = this.modelKey
    const res = await this.send(`/v1/agents/${encodeURIComponent(agent)}/wake`, JSON.stringify(body), headers)
    const json = (await res.json()) as Omit<WakeResult, 'idempotentReplay'>
    return { ...json, idempotentReplay: res.headers.get('Idempotent-Replay') === 'true' }
  }

  /** Re-render a wake's prompts from the journal and compare them to what the model was shown. Spends nothing. */
  async replay(agent: string, wakeId: string): Promise<ReplayResult> {
    const headers = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }
    const res = await this.send(`/v1/agents/${encodeURIComponent(agent)}/replay`, JSON.stringify({ wake: wakeId }), headers)
    const json = (await res.json()) as Partial<ReplayResult>
    const turns = json.turns ?? []
    const count = (pred: (t: ReplayTurn) => boolean) => turns.filter(pred).length
    return {
      ...json,
      turns,
      matched: json.matched ?? count((t) => t.match === true),
      mismatched: json.mismatched ?? count((t) => t.match === false),
      unverifiable: json.unverifiable ?? count((t) => t.match === null),
    }
  }

  private async send(path: string, body: string, headers: Record<string, string>): Promise<Response> {
    let failures = 0
    let queued = 0
    for (;;) {
      let res: Response | undefined
      let netError: unknown
      try {
        res = await this.doFetch(this.baseUrl + path, {
          method: 'POST',
          headers,
          body,
          ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
        })
      } catch (e) {
        netError = e
      }
      if (res && res.ok) return res
      if (res && res.status === 409) {
        const info = (await res.json().catch(() => ({}))) as { retry_after?: number }
        if (++queued > this.maxQueuedWaits) throw new ArgenticError('still queued after waiting', 409, info)
        await this.sleep(Math.min(Math.max(info.retry_after ?? 1, 0), 5) * 1000)
        continue
      }
      if (res && res.status < 500) {
        const info = await res.json().catch(() => undefined)
        const { error: code, detail } = (info ?? {}) as { error?: string; detail?: unknown }
        const more = detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
        throw new ArgenticError(`${res.status} ${code ?? res.statusText}${more}`, res.status, info)
      }
      // 5xx or network error: same request, same key.
      if (failures >= this.backoffMs.length) {
        const what = res ? `HTTP ${res.status}` : String((netError as Error)?.message ?? netError)
        throw new ArgenticError(`gave up after ${failures + 1} tries: ${what}`, res?.status)
      }
      await this.sleep(this.backoffMs[failures++])
    }
  }
}

// ---------------------------------------------------------------------------
// Due notices: verify the signed notice the hosted API posts to your wake_url, then wake the agent.

/** What the notice says. It names the agent and why it is due, never its content. */
export interface DueNotice {
  type: 'agent.due'
  agent: string
  memory: string | null
  reasons: string[]
  /** ISO time the agent became due. */
  since: string
}

export type WebhookErrorCode = 'bad_secret' | 'missing_header' | 'bad_timestamp' | 'stale' | 'bad_signature' | 'bad_body'

/** The notice cannot be trusted or read. Nothing was woken. `code` says why. */
export class WebhookVerificationError extends Error {
  constructor(message: string, readonly code: WebhookErrorCode) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

/** A Fetch API Request, or the raw body text with its headers. */
export type DueRequest = Request | { body: string; headers: Record<string, string> | Headers }

export interface VerifyOptions {
  /** The `whsec_...` secret shown when the wake_url was registered. Defaults to the ARGENTIC_WEBHOOK_SECRET environment variable. */
  secret?: string
  /** How far the notice's timestamp may be from now, either way, in seconds. Default 300. */
  toleranceSeconds?: number
  /** The current time in milliseconds. For tests. */
  now?: () => number
}

export interface DueOptions extends VerifyOptions {
  /** The client that wakes the agent. Defaults to a new Argentic(), which reads ARGENTIC_API_KEY and MODEL_KEY. */
  client?: Argentic
  model?: ModelSpec
}

/** `v1,<base64 HMAC-SHA256>` over "id.timestamp.body", keyed by the base64-decoded part of the secret after `whsec_`. Standard Webhooks. */
export function signNotice(secret: string, id: string, timestamp: number | string, body: string): string {
  return `v1,${createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

function secretKey(secret: string | undefined): Buffer {
  const b64 = (secret ?? '').replace(/^whsec_/, '')
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0 ? Buffer.from(b64, 'base64') : undefined
  if (!key?.length) throw new WebhookVerificationError('the webhook secret is missing or not a whsec_ base64 string (set ARGENTIC_WEBHOOK_SECRET)', 'bad_secret')
  return key
}

async function readDue(req: DueRequest): Promise<{ body: string; get: (name: string) => string | undefined }> {
  if (typeof Request !== 'undefined' && req instanceof Request) return { body: await req.text(), get: (n) => req.headers.get(n) ?? undefined }
  const { body, headers } = req as { body: string; headers: Record<string, string> | Headers }
  if (headers instanceof Headers) return { body, get: (n) => headers.get(n) ?? undefined }
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { body, get: (n) => lower.get(n) }
}

/**
 * Check the signature and the time, then parse the notice. No network. The signature is checked against the body exactly as it arrived,
 * so pass the raw text, not re-serialized JSON. Use it to queue the notice and wake later; the returned `id` is the key to wake with.
 */
export async function verifyDue(req: DueRequest, opts: VerifyOptions = {}): Promise<{ notice: DueNotice; id: string }> {
  const key = secretKey(opts.secret ?? process.env.ARGENTIC_WEBHOOK_SECRET)
  const { body, get } = await readDue(req)
  const id = get('webhook-id')
  const stamp = get('webhook-timestamp')
  const sigs = get('webhook-signature')
  if (!id || !stamp || !sigs) throw new WebhookVerificationError('missing webhook-id, webhook-timestamp or webhook-signature header', 'missing_header')
  if (!/^\d{1,12}$/.test(stamp)) throw new WebhookVerificationError('webhook-timestamp is not a number of seconds', 'bad_timestamp')
  const nowS = (opts.now ?? Date.now)() / 1000
  if (Math.abs(nowS - Number(stamp)) > (opts.toleranceSeconds ?? 300)) throw new WebhookVerificationError('webhook-timestamp is outside the allowed window', 'stale')
  const expected = createHmac('sha256', key).update(`${id}.${stamp}.${body}`).digest()
  let ok = false
  for (const entry of sigs.split(/\s+/)) {
    const [version, sig] = entry.split(',')
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true
  }
  if (!ok) throw new WebhookVerificationError('no webhook-signature matches', 'bad_signature')
  let notice: DueNotice
  try {
    notice = JSON.parse(body)
  } catch {
    throw new WebhookVerificationError('the notice body is not JSON', 'bad_body')
  }
  if (notice?.type !== 'agent.due' || typeof notice.agent !== 'string' || !notice.agent) throw new WebhookVerificationError('not an agent.due notice', 'bad_body')
  return { notice, id }
}

/**
 * Verify a due notice, then wake the agent for what fell due, on your own model key (the notice carries none).
 * The wake's idempotency key comes from the notice's webhook-id, so a notice delivered again replays the first wake's answer.
 * Throws WebhookVerificationError before any call is made if the notice is not valid.
 */
export async function handleDue(req: DueRequest, opts: DueOptions = {}): Promise<{ notice: DueNotice; wake: WakeResult }> {
  const { notice, id } = await verifyDue(req, opts)
  const body: WakeBody = { fire_due: true, model: opts.model ?? freeModel }
  if (notice.memory != null) body.memory = notice.memory
  const wake = await (opts.client ?? new Argentic()).wake(notice.agent, body, safeKey(id))
  return { notice, wake }
}

/** handleDue as a route handler's answer: 200 woken, 401 not verified, 400 unreadable body, 500 secret not set up, 502 the wake failed (so the notice is sent again). */
export async function handleDueResponse(req: DueRequest, opts: DueOptions = {}): Promise<Response> {
  try {
    const { notice, wake } = await handleDue(req, opts)
    return Response.json({ agent: notice.agent, wake_id: wake.wake_id, status: wake.status })
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      const status = e.code === 'bad_body' ? 400 : e.code === 'bad_secret' ? 500 : 401
      return Response.json({ error: e.code }, { status })
    }
    return Response.json({ error: 'wake_failed' }, { status: 502 })
  }
}

// ---------------------------------------------------------------------------
// Ledger: what your tools already did, kept in a local JSON file.

export interface LedgerEntry {
  tool: string
  args: Record<string, unknown>
  result: unknown
  at: string
}

/** A wake that stopped at its turn or time limit with actions to run, kept so a restart sends their results instead of asking the wake again. */
export type StoppedWake = Omit<WakeResult, 'idempotentReplay'>

export class Ledger {
  private entries: Record<string, LedgerEntry> = {}
  private wakes: Record<string, StoppedWake> = {}

  /**
   * A missing file starts an empty ledger. A file that cannot be read or parsed is set aside as `<path>.corrupt` and `onCorrupt`
   * is told, because an empty ledger means finished actions may run again. `onCorrupt` defaults to console.warn.
   */
  constructor(readonly path: string, onCorrupt: (message: string) => void = (m) => console.warn(m)) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      onCorrupt(`argentic: cannot read the ledger ${path} (${(e as Error).message}); starting empty, so finished actions may run again`)
      return
    }
    try {
      const saved = JSON.parse(text)
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a JSON object')
      this.entries = saved.entries ?? {}
      this.wakes = saved.wakes ?? {}
    } catch (e) {
      this.entries = {}
      this.wakes = {}
      let kept = ''
      try {
        renameSync(path, `${path}.corrupt`)
        kept = `, the old file is kept as ${path}.corrupt`
      } catch {}
      onCorrupt(`argentic: the ledger ${path} is not valid (${(e as Error).message}); starting empty, so finished actions may run again${kept}`)
    }
  }

  get(key: string): LedgerEntry | undefined {
    return this.entries[key]
  }

  set(key: string, entry: LedgerEntry): void {
    this.entries[key] = entry
    this.save()
  }

  /** The stopped wake answered for this idempotency key, if one was kept. */
  getWake(key: string): StoppedWake | undefined {
    return this.wakes[key]
  }

  setWake(key: string, wake: StoppedWake): void {
    this.wakes[key] = wake
    this.save()
  }

  /** Write temp file, then rename, so a crash never leaves half a ledger. */
  private save(): void {
    mkdirSync(dirname(this.path) || '.', { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.keys(this.wakes).length ? { entries: this.entries, wakes: this.wakes } : { entries: this.entries }, null, 2))
    renameSync(tmp, this.path)
  }
}

// ---------------------------------------------------------------------------
// runDurable

/**
 * Throw this from a tool when the outcome is not known yet and the same call is safe to try again:
 * a network drop, a timeout, a provider that is down. runDurable does not write it to the ledger,
 * so it stops the run. Run it again and the action is asked for again with the same key.
 */
export class RetryLater extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'RetryLater'
  }
}

export interface ToolContext {
  seq: number
  /** `${agent}:${seq}`. Use it to make the side effect safe to repeat. */
  idempotencyKey: string
}

export interface DurableTool extends ToolDecl {
  execute: (args: any, ctx: ToolContext) => unknown | Promise<unknown>
}

export interface ActionInfo {
  tool: string
  seq: number
  /** Number of actions newly executed in this process so far. */
  executed: number
}

export interface RunOptions {
  client: Argentic
  agent: string
  /** Chosen by you and kept the same across restarts. */
  runId: string
  task: string
  system?: string
  tools: DurableTool[]
  ledgerPath: string
  model?: ModelSpec
  maxSteps?: number
  limits?: WakeBody['limits']
  /** Called just before each wake is sent, so a caller can say it is waiting on the model (the first answer can take several seconds). */
  onWakeStart?: (info: { step: number }) => void
  /** Called after each newly executed action is written to the ledger. */
  onAction?: (info: ActionInfo) => void
  /** Called for an action the ledger says already finished, so it is not run again. */
  onSkip?: (info: { tool: string; seq: number }) => void
  /** Called after each wake answers. `replayed` means the API sent back its stored answer for this key, or the ledger kept a stopped one. */
  onWake?: (info: { step: number; wakeId: string; status: WakeStatus; replayed: boolean }) => void
  /** Kill this process hard after the Nth newly executed action (to try a crash). */
  crashAfterActions?: number
  log?: (line: string) => void
}

export interface RunResult {
  reply: string
  wakes: string[]
  steps: number
  status: WakeStatus | 'max_steps'
  spentUsd: number
}

const safeKey = (s: string) => s.replace(/[^A-Za-z0-9\-_.:]/g, '-').slice(0, 128)

/**
 * A wake stopped by its turn or time limit leaves the agent mid-task. Its actions have not been answered, so the next
 * wake sends their results and the agent carries on from there with them, instead of the same key resuming it blind.
 */
const carriesOn = (s: WakeStatus) => s === 'turn_cap' || s === 'time_cap'

export async function runDurable(opts: RunOptions): Promise<RunResult> {
  const { client, agent, tools } = opts
  const log = opts.log ?? ((line: string) => console.log(line))
  const maxSteps = opts.maxSteps ?? 8
  const model = opts.model ?? freeModel
  const ledger = new Ledger(opts.ledgerPath)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const decls: ToolDecl[] = tools.map(({ name, description, parameters }) => ({
    name,
    description: description || name,
    parameters: toArgenticSchema(parameters),
  }))

  const wakes: string[] = []
  let message = opts.task
  let reply = ''
  let spentUsd = 0
  let status: RunResult['status'] = 'max_steps'
  let steps = 0
  let executed = 0

  for (let step = 0; step < maxSteps; step++) {
    const key = safeKey(`${opts.runId}.${step}`)
    const body: WakeBody = { message, model, tools: decls }
    opts.onWakeStart?.({ step })
    if (opts.system) body.system = opts.system
    if (opts.limits) body.limits = opts.limits

    // A stopped wake kept in the ledger is not asked again: its actions get their results under the next key.
    const kept = ledger.getWake(key)
    const res: WakeResult = kept ? { ...kept, idempotentReplay: true } : await client.wake(agent, body, key)
    if (!kept && carriesOn(res.status) && res.actions?.length) {
      const { idempotentReplay: _, ...answer } = res
      ledger.setWake(key, answer)
    }
    steps = step + 1
    wakes.push(res.wake_id)
    reply = res.reply ?? ''
    spentUsd += res.spent_usd ?? 0
    status = res.status
    log(`step ${step}: wake ${res.wake_id} ${res.status}${kept ? ' (stopped answer kept in the ledger)' : res.idempotentReplay ? ' (stored answer replayed)' : ''}`)
    opts.onWake?.({ step, wakeId: res.wake_id, status: res.status, replayed: !!res.idempotentReplay })

    const actions = res.actions ?? []
    const results: { tool: string; seq: number; result: unknown }[] = []
    for (const action of actions) {
      const ledgerKey = `${agent}:${action.seq}`
      const done = ledger.get(ledgerKey)
      if (done) {
        log(`skip seq ${action.seq} ${action.tool}: already done before`)
        opts.onSkip?.({ tool: action.tool, seq: action.seq })
        results.push({ tool: action.tool, seq: action.seq, result: done.result })
        continue
      }
      const tool = byName.get(action.tool)
      let result: unknown
      if (!tool) {
        result = { error: 'unknown tool' }
      } else {
        try {
          result = await tool.execute(action.args ?? {}, { seq: action.seq, idempotencyKey: ledgerKey })
        } catch (e) {
          if (e instanceof RetryLater) throw e
          result = { error: e instanceof Error ? e.message : String(e) }
        }
      }
      ledger.set(ledgerKey, { tool: action.tool, args: action.args ?? {}, result: result ?? null, at: new Date().toISOString() })
      executed++
      log(`ran seq ${action.seq} ${action.tool}`)
      results.push({ tool: action.tool, seq: action.seq, result: ledger.get(ledgerKey)!.result })
      opts.onAction?.({ tool: action.tool, seq: action.seq, executed })
      if (opts.crashAfterActions && executed >= opts.crashAfterActions) {
        log(`simulating a crash after ${executed} action(s)`)
        process.kill(process.pid, 'SIGKILL')
      }
    }

    if (actions.length === 0 || !(res.status === 'done' || carriesOn(res.status))) break
    message = 'Results of the tools you asked for:\n' + JSON.stringify(results)
  }

  return { reply, wakes, steps, status, spentUsd }
}
