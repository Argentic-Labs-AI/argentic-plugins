// Retry-safe tools for real services: Stripe, Resend, SMTP, Slack, GitHub and a generic HTTP POST.
// Every action Argentic hands you carries a stable key (`agent:seq`). These tools use it so a cut-off
// action can be tried again safely: the provider's own idempotency where it has one, and for the three
// that have none (SMTP, Slack, GitHub) a marker the tool looks for before it sends again.
// No dependencies, Node 22+. What each provider can and cannot promise is in TOOLS.md.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { RetryLater, type DurableTool, type ToolContext } from './argentic.ts'

// ---------------------------------------------------------------------------
// Options

/** What to do with a Slack, GitHub or SMTP action that may or may not have landed and cannot be checked. */
export type Ambiguous = 'hold' | 'retry'

export interface StripeOptions {
  secretKey: string
  baseUrl?: string
  /** Refuse any refund or charge above this many minor units (cents), whatever the model asks. */
  maxAmount?: number
}
export interface ResendOptions {
  apiKey: string
  /** The From address. The model never picks it. */
  from: string
  baseUrl?: string
}
export interface SmtpOptions {
  host: string
  port?: number
  /** Implicit TLS (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure?: boolean
  user?: string
  pass?: string
  from: string
  /** Default 'hold': a send cut off after the message was handed over is not sent again. */
  onAmbiguous?: Ambiguous
  /** Skip certificate checks. For a local test server only. */
  insecureTls?: boolean
}
export interface SlackOptions {
  token: string
  baseUrl?: string
  /** Only these channel ids may be posted to. */
  channels?: string[]
  /** Default 'hold'. Looking a message up needs the channel's history scope; without it the tool cannot check. */
  onAmbiguous?: Ambiguous
}
export interface GithubOptions {
  token: string
  baseUrl?: string
  /** Only these `owner/repo` names may be written to. */
  repos?: string[]
  onAmbiguous?: Ambiguous
}
export interface HttpOptions {
  /** Hosts the model may POST to. Nothing else is called. */
  allowHosts: string[]
  /** Fixed headers, such as Authorization. The model never sees or sets them. */
  headers?: Record<string, string>
  /** Allow http:// to an allowed host. Off by default. */
  allowHttp?: boolean
}

export interface ToolPackOptions {
  stripe?: StripeOptions
  resend?: ResendOptions
  smtp?: SmtpOptions
  slack?: SlackOptions
  github?: GithubOptions
  http?: HttpOptions
  /** Where intents are kept so a restart knows what was started. Default `.argentic-intents.json`. */
  statePath?: string
  /** Tries per action inside one process before the run stops with RetryLater. Default 4. */
  tries?: number
  /** Waits between tries, in ms. Default 500, 1500, 4000. */
  backoffMs?: number[]
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Intent log: written before the call (started) and after it (done).

interface Intent {
  state: 'started' | 'done'
  tool: string
  at: string
  result?: unknown
}

class IntentLog {
  private entries: Record<string, Intent> = {}
  constructor(readonly path: string) {
    try {
      this.entries = JSON.parse(readFileSync(path, 'utf8')).entries ?? {}
    } catch {
      this.entries = {}
    }
  }
  get(key: string): Intent | undefined {
    return this.entries[key]
  }
  set(key: string, e: Intent): void {
    this.entries[key] = e
    mkdirSync(dirname(this.path) || '.', { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2))
    renameSync(tmp, this.path)
  }
}

// ---------------------------------------------------------------------------
// Shared pieces

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A key a provider accepts (Stripe allows 255 characters, Resend 256). */
export function providerKey(key: string): string {
  return key.length <= 200 ? key : 'sha256:' + createHash('sha256').update(key).digest('hex')
}

class Runtime {
  readonly log: IntentLog
  readonly doFetch: typeof fetch
  readonly sleep: (ms: number) => Promise<void>
  readonly tries: number
  readonly backoffMs: number[]
  constructor(o: ToolPackOptions) {
    this.log = new IntentLog(o.statePath ?? '.argentic-intents.json')
    this.doFetch = o.fetch ?? fetch
    this.sleep = o.sleep ?? wait
    this.tries = Math.max(1, o.tries ?? 4)
    this.backoffMs = o.backoffMs ?? [500, 1500, 4000]
  }

  /**
   * Run one action once. A finished intent returns its stored result. `attempt` tells the sender
   * whether an earlier attempt may have landed (a restart that found "started", or a retry in this process).
   */
  async once(
    ctx: ToolContext,
    tool: string,
    send: (c: { maybeSent: boolean; startedAt: string }) => Promise<unknown>,
  ): Promise<unknown> {
    const prior = this.log.get(ctx.idempotencyKey)
    if (prior?.state === 'done') return prior.result
    const startedAt = prior?.at ?? new Date().toISOString()
    if (!prior) this.log.set(ctx.idempotencyKey, { state: 'started', tool, at: startedAt })
    const result = await send({ maybeSent: prior?.state === 'started', startedAt })
    this.log.set(ctx.idempotencyKey, { state: 'done', tool, at: startedAt, result })
    return result
  }

  /** Same request again after a network error, 429 or 5xx, then RetryLater. `fn` returns a Response or throws. */
  async withRetry(what: string, fn: (attempt: number) => Promise<Response>, retryOn5xx = true): Promise<Response> {
    let last = ''
    for (let attempt = 0; attempt < this.tries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0)
      let res: Response
      try {
        res = await fn(attempt)
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
        continue
      }
      if (res.status === 429 || res.status === 409 || (retryOn5xx && res.status >= 500)) {
        last = `HTTP ${res.status}`
        const ra = Number(res.headers.get('retry-after'))
        if (ra > 0) await this.sleep(Math.min(ra, 30) * 1000)
        continue
      }
      return res
    }
    throw new RetryLater(`${what}: no answer after ${this.tries} tries (${last}). Run again to try the same action with the same key.`)
  }
}

/**
 * For a provider with no idempotency: a network error or 5xx may have landed, so before posting again look for
 * the action by its marker. `lookup` returns the found item, undefined for "not there", or null for "cannot check".
 * A 429 was not processed, so it is simply tried again.
 */
async function guarded<T>(
  rt: Runtime,
  what: string,
  policy: Ambiguous,
  lookupFirst: boolean,
  post: () => Promise<Response>,
  lookup: () => Promise<T | undefined | null>,
): Promise<{ res: Response } | { hit: T } | { unknown: true }> {
  let maybe = lookupFirst
  let last = ''
  for (let attempt = 0; attempt < rt.tries; attempt++) {
    if (attempt > 0) await rt.sleep(rt.backoffMs[Math.min(attempt - 1, rt.backoffMs.length - 1)] ?? 0)
    if (maybe) {
      const found = await lookup()
      if (found) return { hit: found }
      if (found === null && policy === 'hold') return { unknown: true }
    }
    try {
      const res = await post()
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'))
        if (ra > 0) await rt.sleep(Math.min(ra, 30) * 1000)
        last = 'HTTP 429'
        continue
      }
      if (res.status >= 500) {
        maybe = true
        last = `HTTP ${res.status}`
        continue
      }
      return { res }
    } catch (e) {
      maybe = true
      last = e instanceof Error ? e.message : String(e)
    }
  }
  throw new RetryLater(`${what}: no answer after ${rt.tries} tries (${last}). Run again: it looks for the action before sending it again.`)
}

const bodyOf = async (res: Response): Promise<any> => {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

const str = { type: 'string' }
const ambiguousNote = (what: string) =>
  `${what} may or may not have been delivered before the process stopped, and it cannot be checked. It was not sent again. Check by hand before asking for it again.`

// ---------------------------------------------------------------------------
// Stripe: native idempotency (Idempotency-Key header).

function stripeTools(rt: Runtime, o: StripeOptions): DurableTool[] {
  const base = (o.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  const call = async (ctx: ToolContext, path: string, params: Record<string, string>) => {
    const res = await rt.withRetry(
      'stripe',
      () =>
        rt.doFetch(base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${o.secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': providerKey(ctx.idempotencyKey),
          },
          body: new URLSearchParams(params).toString(),
        }),
      // Stripe stores a 500 under the key and replays it, so asking again cannot change it.
      false,
    )
    const json = await bodyOf(res)
    const replayed = res.headers.get('idempotent-replayed') === 'true'
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error?.message ?? json?.error?.code ?? 'request failed', code: json?.error?.code, replayed }
    }
    return { ok: true, id: json.id, status: json.status, amount: json.amount, currency: json.currency, replayed }
  }
  const capped = (amount: unknown): string | undefined => {
    if (!Number.isInteger(amount) || (amount as number) <= 0) return 'amount must be a positive whole number of minor units (cents)'
    if (o.maxAmount !== undefined && (amount as number) > o.maxAmount) return `amount is over the limit of ${o.maxAmount}`
    return undefined
  }
  return [
    {
      name: 'stripe_refund',
      description: 'Refund a Stripe payment. Give the payment_intent id (pi_...) and, for a partial refund, the amount in cents.',
      parameters: {
        type: 'object',
        properties: { payment_intent: str, amount: { type: 'integer', description: 'cents; omit to refund the whole payment' }, reason: { type: 'string', enum: ['duplicate', 'fraudulent', 'requested_by_customer'] } },
        required: ['payment_intent'],
      },
      execute: (args, ctx) =>
        rt.once(ctx, 'stripe_refund', async () => {
          if (args.amount !== undefined) {
            const bad = capped(args.amount)
            if (bad) return { ok: false, error: bad }
          } else if (o.maxAmount !== undefined) {
            return { ok: false, error: 'a full refund needs an amount while a limit is set' }
          }
          const p: Record<string, string> = { payment_intent: String(args.payment_intent) }
          if (args.amount !== undefined) p.amount = String(args.amount)
          if (args.reason) p.reason = String(args.reason)
          return call(ctx, '/v1/refunds', p)
        }),
    },
    {
      name: 'stripe_charge',
      description: 'Charge a saved Stripe customer off-session. Give the customer id (cus_...), a payment_method id (pm_...), the amount in cents and a 3-letter currency.',
      parameters: {
        type: 'object',
        properties: { customer: str, payment_method: str, amount: { type: 'integer' }, currency: str, description: str },
        required: ['customer', 'payment_method', 'amount', 'currency'],
      },
      execute: (args, ctx) =>
        rt.once(ctx, 'stripe_charge', async () => {
          const bad = capped(args.amount)
          if (bad) return { ok: false, error: bad }
          const p: Record<string, string> = {
            customer: String(args.customer),
            payment_method: String(args.payment_method),
            amount: String(args.amount),
            currency: String(args.currency).toLowerCase(),
            confirm: 'true',
            off_session: 'true',
          }
          if (args.description) p.description = String(args.description)
          return call(ctx, '/v1/payment_intents', p)
        }),
    },
  ]
}

// ---------------------------------------------------------------------------
// Resend: native idempotency (Idempotency-Key header).

function resendTools(rt: Runtime, o: ResendOptions, name: string): DurableTool[] {
  const base = (o.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '')
  return [
    {
      name,
      description: 'Send an email. Plain text in body; add html for a formatted version.',
      parameters: { type: 'object', properties: { to: str, subject: str, body: str, html: str, reply_to: str }, required: ['to', 'subject', 'body'] },
      execute: (args, ctx) =>
        rt.once(ctx, name, async () => {
          const payload: Record<string, unknown> = { from: o.from, to: [String(args.to)], subject: String(args.subject), text: String(args.body) }
          if (args.html) payload.html = String(args.html)
          if (args.reply_to) payload.reply_to = String(args.reply_to)
          const res = await rt.withRetry('resend', () =>
            rt.doFetch(base + '/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': providerKey(ctx.idempotencyKey) },
              body: JSON.stringify(payload),
            }),
          )
          const json = await bodyOf(res)
          if (!res.ok) return { ok: false, status: res.status, error: json?.message ?? json?.name ?? 'request failed' }
          return { ok: true, id: json.id, to: args.to }
        }),
    },
  ]
}

// ---------------------------------------------------------------------------
// SMTP: no idempotency exists. A deterministic Message-ID, an intent written first, and a hold on the ambiguous case.

class SmtpError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly handedOver: boolean) {
    super(message)
  }
}

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')
const header = (s: string) => s.replace(/[\r\n]+/g, ' ')

async function smtpSend(o: SmtpOptions, msg: { to: string; subject: string; body: string; messageId: string; key: string }): Promise<void> {
  const port = o.port ?? (o.secure ? 465 : 587)
  let sock: net.Socket = o.secure
    ? tls.connect({ host: o.host, port, rejectUnauthorized: !o.insecureTls })
    : net.connect({ host: o.host, port })
  sock.setTimeout(30_000)
  let buf = ''
  let handedOver = false
  const waiters: ((line: string) => void)[] = []
  let failure: Error | undefined
  const onData = (d: Buffer) => {
    buf += d.toString('utf8')
    for (;;) {
      const m = buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/)
      if (!m) return
      buf = buf.slice(m[0].length)
      waiters.shift()?.(m[0])
    }
  }
  const fail = (e: Error) => {
    failure = failure ?? e
    while (waiters.length) waiters.shift()!('')
  }
  const attach = (s: net.Socket) => {
    s.on('data', onData)
    s.on('error', fail)
    s.on('timeout', () => fail(new Error('smtp timeout')))
    s.on('close', () => fail(new Error('smtp connection closed')))
  }
  attach(sock)
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      if (failure) return reject(failure)
      waiters.push((line) => (failure && !line ? reject(failure) : resolve(line)))
    })
  const expect = async (ok: number[]) => {
    const r = await reply()
    const code = Number(r.slice(0, 3))
    if (!ok.includes(code)) throw new SmtpError(`smtp ${r.trim().slice(0, 200)}`, code, handedOver)
    return r
  }
  const cmd = async (line: string, ok: number[]) => {
    sock.write(line + '\r\n')
    return expect(ok)
  }
  try {
    await expect([220])
    let ehlo = await cmd(`EHLO argentic.local`, [250])
    if (!o.secure && /STARTTLS/i.test(ehlo)) {
      await cmd('STARTTLS', [220])
      sock.removeAllListeners('data')
      const upgraded = tls.connect({ socket: sock, host: o.host, rejectUnauthorized: !o.insecureTls })
      sock = upgraded
      attach(upgraded)
      buf = ''
      ehlo = await cmd(`EHLO argentic.local`, [250])
    }
    if (o.user) {
      const token = Buffer.from(`\0${o.user}\0${o.pass ?? ''}`).toString('base64')
      await cmd(`AUTH PLAIN ${token}`, [235])
    }
    const from = o.from.match(/<([^>]+)>/)?.[1] ?? o.from
    await cmd(`MAIL FROM:<${header(from)}>`, [250])
    await cmd(`RCPT TO:<${header(msg.to)}>`, [250, 251])
    await cmd('DATA', [354])
    const text = [
      `From: ${header(o.from)}`,
      `To: ${header(msg.to)}`,
      `Subject: ${header(msg.subject)}`,
      `Message-ID: ${msg.messageId}`,
      `X-Argentic-Idempotency-Key: ${header(msg.key)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      crlf(msg.body).replace(/^\./gm, '..'),
    ].join('\r\n')
    // From here on a cut-off connection leaves it unknown whether the server queued the message.
    handedOver = true
    sock.write(text + '\r\n.\r\n')
    await expect([250])
    handedOver = false
    sock.write('QUIT\r\n')
  } catch (e) {
    if (e instanceof SmtpError) throw e
    throw new SmtpError(e instanceof Error ? e.message : String(e), undefined, handedOver)
  } finally {
    sock.destroy()
  }
}

function smtpTools(rt: Runtime, o: SmtpOptions, name: string): DurableTool[] {
  const policy = o.onAmbiguous ?? 'hold'
  const domain = (o.from.match(/@([^>\s]+)/)?.[1] ?? 'argentic.local').replace(/[^A-Za-z0-9.-]/g, '')
  return [
    {
      name,
      description: 'Send a plain-text email.',
      parameters: { type: 'object', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
      execute: (args, ctx) =>
        rt.once(ctx, name, async ({ maybeSent }) => {
          if (maybeSent && policy === 'hold') {
            return { ok: false, outcome: 'unknown', note: ambiguousNote('This email') }
          }
          const messageId = `<${createHash('sha256').update(ctx.idempotencyKey).digest('hex').slice(0, 32)}@${domain}>`
          for (let attempt = 0; attempt < rt.tries; attempt++) {
            if (attempt > 0) await rt.sleep(rt.backoffMs[Math.min(attempt - 1, rt.backoffMs.length - 1)] ?? 0)
            try {
              await smtpSend(o, { to: String(args.to), subject: String(args.subject), body: String(args.body), messageId, key: ctx.idempotencyKey })
              return { ok: true, to: args.to, messageId }
            } catch (e) {
              const err = e as SmtpError
              if (err.code !== undefined && err.code >= 500) return { ok: false, error: err.message }
              if (err.handedOver) {
                // The server may have queued it. Same Message-ID lets a receiver spot a copy, but nothing guarantees it.
                if (policy === 'hold') return { ok: false, outcome: 'unknown', note: ambiguousNote('This email') }
              }
            }
          }
          throw new RetryLater('smtp: could not reach the server. Run again to try the same email.')
        }),
    },
  ]
}

// ---------------------------------------------------------------------------
// Slack: no idempotency. The key rides in message metadata; before any repeat the tool looks for it.

function slackTools(rt: Runtime, o: SlackOptions): DurableTool[] {
  const base = (o.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
  const policy = o.onAmbiguous ?? 'hold'
  const call = (method: string, payload: Record<string, unknown>) =>
    rt.doFetch(`${base}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    })
  return [
    {
      name: 'slack_post_message',
      description: 'Post a message to a Slack channel (channel id, such as C0123ABCD). thread_ts replies in a thread.',
      parameters: { type: 'object', properties: { channel: str, text: str, thread_ts: str }, required: ['channel', 'text'] },
      execute: (args, ctx) =>
        rt.once(ctx, 'slack_post_message', async ({ maybeSent, startedAt }) => {
          const channel = String(args.channel)
          if (o.channels && !o.channels.includes(channel)) return { ok: false, error: `channel ${channel} is not allowed` }
          const threadTs = args.thread_ts ? String(args.thread_ts) : undefined
          const lookup = async () => {
            const oldest = String(Math.floor(Date.parse(startedAt) / 1000) - 60)
            try {
              const res = await call(threadTs ? 'conversations.replies' : 'conversations.history', { channel, ...(threadTs ? { ts: threadTs } : {}), oldest, limit: 100, include_all_metadata: true })
              const r = await bodyOf(res)
              if (!r?.ok) return null
              return (r.messages ?? []).find((m: any) => m?.metadata?.event_payload?.key === ctx.idempotencyKey)
            } catch {
              return null
            }
          }
          const post = () =>
            call('chat.postMessage', {
              channel,
              text: String(args.text),
              ...(threadTs ? { thread_ts: threadTs } : {}),
              metadata: { event_type: 'argentic_action', event_payload: { key: ctx.idempotencyKey } },
            })
          const out = await guarded(rt, 'slack', policy, maybeSent, post, lookup)
          if ('unknown' in out) return { ok: false, outcome: 'unknown', note: ambiguousNote('This Slack message') }
          if ('hit' in out) return { ok: true, ts: out.hit.ts, channel, found: true }
          const r = await bodyOf(out.res)
          if (!r?.ok) return { ok: false, error: r?.error ?? `HTTP ${out.res.status}` }
          return { ok: true, ts: r.ts, channel }
        }),
    },
  ]
}

// ---------------------------------------------------------------------------
// GitHub: no idempotency. A hidden marker in the body; before any repeat the tool lists and looks for it.

const marker = (key: string) => `<!-- argentic-key:${key.replace(/--/g, '-')} -->`

function githubTools(rt: Runtime, o: GithubOptions): DurableTool[] {
  const base = (o.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const policy = o.onAmbiguous ?? 'hold'
  const h = { Authorization: `Bearer ${o.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }
  const repoOk = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo) && (!o.repos || o.repos.includes(repo))
  /** Scan newest-first pages of a list for the marker. Lists are read straight from the database, unlike search. */
  const scan = async (url: string, mk: string): Promise<any | undefined | null> => {
    try {
      for (let page = 1; page <= 3; page++) {
        const res = await rt.doFetch(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers: h })
        if (!res.ok) return null
        const items = (await res.json()) as any[]
        const hit = items.find((i) => typeof i.body === 'string' && i.body.includes(mk) && !i.pull_request)
        if (hit) return hit
        if (items.length < 100) return undefined
      }
      return undefined
    } catch {
      return null
    }
  }
  const run = (name: string, listUrl: (a: any, since: string) => string, createUrl: (a: any) => string, makePayload: (a: any, mk: string) => Record<string, unknown>) =>
    (args: any, ctx: ToolContext) =>
      rt.once(ctx, name, async ({ maybeSent, startedAt }) => {
        const repo = String(args.repo)
        if (!repoOk(repo)) return { ok: false, error: `repo ${repo} is not allowed` }
        const mk = marker(ctx.idempotencyKey)
        const since = new Date(Date.parse(startedAt) - 60_000).toISOString()
        const out = await guarded(
          rt,
          'github',
          policy,
          maybeSent,
          () => rt.doFetch(createUrl(args), { method: 'POST', headers: h, body: JSON.stringify(makePayload(args, mk)) }),
          () => scan(listUrl(args, since), mk),
        )
        if ('unknown' in out) return { ok: false, outcome: 'unknown', note: ambiguousNote('This GitHub write') }
        if ('hit' in out) return { ok: true, number: out.hit.number, id: out.hit.id, url: out.hit.html_url, found: true }
        const json = await bodyOf(out.res)
        if (!out.res.ok) return { ok: false, status: out.res.status, error: json?.message ?? 'request failed' }
        return { ok: true, number: json.number, id: json.id, url: json.html_url }
      })
  return [
    {
      name: 'github_create_issue',
      description: 'Open a GitHub issue. repo is owner/name.',
      parameters: { type: 'object', properties: { repo: str, title: str, body: str, labels: { type: 'array', items: { type: 'string' } } }, required: ['repo', 'title'] },
      execute: run(
        'github_create_issue',
        (a, since) => `${base}/repos/${a.repo}/issues?state=all&sort=created&direction=desc&since=${encodeURIComponent(since)}`,
        (a) => `${base}/repos/${a.repo}/issues`,
        (a, mk) => ({ title: String(a.title), body: `${a.body ?? ''}\n\n${mk}`, ...(Array.isArray(a.labels) ? { labels: a.labels } : {}) }),
      ),
    },
    {
      name: 'github_create_comment',
      description: 'Comment on a GitHub issue or pull request. repo is owner/name.',
      parameters: { type: 'object', properties: { repo: str, issue_number: { type: 'integer' }, body: str }, required: ['repo', 'issue_number', 'body'] },
      execute: run(
        'github_create_comment',
        (a, since) => `${base}/repos/${a.repo}/issues/${Number(a.issue_number)}/comments?since=${encodeURIComponent(since)}`,
        (a) => `${base}/repos/${a.repo}/issues/${Number(a.issue_number)}/comments`,
        (a, mk) => ({ body: `${a.body}\n\n${mk}` }),
      ),
    },
  ]
}

// ---------------------------------------------------------------------------
// Generic HTTP POST with an Idempotency-Key header.

function httpTools(rt: Runtime, o: HttpOptions): DurableTool[] {
  const hosts = new Set(o.allowHosts.map((h) => h.toLowerCase()))
  return [
    {
      name: 'http_post',
      description: 'POST a body to an allowed URL. The receiver is sent an Idempotency-Key for this action.',
      parameters: { type: 'object', properties: { url: str, body: { type: 'string', description: 'the request body, such as JSON text' }, content_type: str }, required: ['url', 'body'] },
      execute: (args, ctx) =>
        rt.once(ctx, 'http_post', async () => {
          let u: URL
          try {
            u = new URL(String(args.url))
          } catch {
            return { ok: false, error: 'not a URL' }
          }
          if (u.protocol !== 'https:' && !(o.allowHttp && u.protocol === 'http:')) return { ok: false, error: 'only https URLs are allowed' }
          if (!hosts.has(u.host.toLowerCase()) && !hosts.has(u.hostname.toLowerCase())) return { ok: false, error: `host ${u.host} is not allowed` }
          const res = await rt.withRetry('http_post', () =>
            rt.doFetch(u, {
              method: 'POST',
              redirect: 'error',
              headers: { ...(o.headers ?? {}), 'Content-Type': String(args.content_type ?? 'application/json'), 'Idempotency-Key': providerKey(ctx.idempotencyKey) },
              body: String(args.body),
            }),
          )
          const text = await res.text()
          return { ok: res.ok, status: res.status, body: text.slice(0, 2000), replayed: res.headers.get('idempotent-replayed') === 'true' || res.headers.get('idempotency-replayed') === 'true' }
        }),
    },
  ]
}

// ---------------------------------------------------------------------------

/**
 * Tools for runDurable. Pass only the services you use; each tool is built from your options and your
 * secrets, never from anything the model sends. With Resend and SMTP both set, Resend is `send_email`
 * and SMTP is `send_email_smtp`.
 */
export function toolPack(opts: ToolPackOptions): DurableTool[] {
  const rt = new Runtime(opts)
  const out: DurableTool[] = []
  if (opts.stripe) out.push(...stripeTools(rt, opts.stripe))
  if (opts.resend) out.push(...resendTools(rt, opts.resend, 'send_email'))
  if (opts.smtp) out.push(...smtpTools(rt, opts.smtp, opts.resend ? 'send_email_smtp' : 'send_email'))
  if (opts.slack) out.push(...slackTools(rt, opts.slack))
  if (opts.github) out.push(...githubTools(rt, opts.github))
  if (opts.http) out.push(...httpTools(rt, opts.http))
  return out
}
