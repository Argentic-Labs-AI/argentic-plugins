// In-process stand-ins for Stripe, Resend, Slack, GitHub, an HTTP receiver and an SMTP server.
// Each counts its real side effects, and can commit one and then drop the connection with no answer
// (`dropNext`): the case a retry-safe tool exists for.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import * as net from 'node:net'

export interface Mock {
  server: Server
  url: string
  /** Real side effects that happened. */
  effects: any[]
  /** Commit the next N effects, then close the connection without answering. */
  dropNext: number
  requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[]
  close: () => Promise<void>
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string, mock: Mock) => void): Promise<Mock> {
  const mock = { effects: [], dropNext: 0, requests: [] } as unknown as Mock
  mock.server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    mock.requests.push({ method: req.method!, path: req.url!, headers: req.headers, body })
    handler(req, res, body, mock)
  })
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r))
  mock.url = `http://127.0.0.1:${(mock.server.address() as net.AddressInfo).port}`
  mock.close = () => new Promise((r) => { mock.server.closeAllConnections(); mock.server.close(() => r()) })
  return mock
}

const send = (res: ServerResponse, code: number, json: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(json))
}
/** After an effect committed: maybe cut the connection instead of answering. */
const maybeDrop = (mock: Mock, res: ServerResponse) => {
  if (mock.dropNext > 0) {
    mock.dropNext--
    res.socket?.destroy()
    return true
  }
  return false
}

/** Stripe and Resend both store the first answer per key and refuse a changed body. */
function idempotent(mock: Mock, key: string | undefined, body: string, res: ServerResponse, make: () => { code: number; json: any }, replayHeader: string, mismatch: () => { code: number; json: any }) {
  const store = ((mock as any).store ??= new Map<string, { body: string; code: number; json: any }>())
  const prior = key ? store.get(key) : undefined
  if (prior) {
    if (prior.body !== body) { const m = mismatch(); return send(res, m.code, m.json) }
    return send(res, prior.code, prior.json, { [replayHeader]: 'true' })
  }
  const made = make()
  if (key) store.set(key, { body, ...made })
  if (maybeDrop(mock, res)) return
  send(res, made.code, made.json)
}

export const stripeMock = () =>
  listen((req, res, body, mock) => {
    if (req.headers.authorization !== 'Bearer sk_test_mock') return send(res, 401, { error: { message: 'bad key' } })
    const p = Object.fromEntries(new URLSearchParams(body))
    const kind = req.url === '/v1/refunds' ? 'refund' : req.url === '/v1/payment_intents' ? 'charge' : undefined
    if (!kind) return send(res, 404, { error: { message: 'no route' } })
    idempotent(
      mock,
      req.headers['idempotency-key'] as string | undefined,
      body,
      res,
      () => {
        if (p.payment_method === 'pm_declined') return { code: 402, json: { error: { code: 'card_declined', message: 'Your card was declined.' } } }
        const id = `${kind === 'refund' ? 're' : 'pi'}_${mock.effects.length + 1}`
        mock.effects.push({ kind, id, ...p })
        return { code: 200, json: { id, status: 'succeeded', amount: Number(p.amount ?? 0), currency: p.currency ?? 'usd' } }
      },
      'Idempotent-Replayed',
      () => ({ code: 400, json: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' } } }),
    )
  })

export const resendMock = () =>
  listen((req, res, body, mock) => {
    if (req.headers.authorization !== 'Bearer re_mock') return send(res, 401, { message: 'bad key' })
    idempotent(
      mock,
      req.headers['idempotency-key'] as string | undefined,
      body,
      res,
      () => {
        const id = `em_${mock.effects.length + 1}`
        mock.effects.push({ id, ...JSON.parse(body) })
        return { code: 200, json: { id } }
      },
      'Idempotent-Replayed',
      () => ({ code: 409, json: { name: 'invalid_idempotent_request', message: 'same key, different payload' } }),
    )
  })

export const httpMock = (opts: { honorsKey: boolean }) =>
  listen((req, res, body, mock) => {
    const key = req.headers['idempotency-key'] as string | undefined
    const store = ((mock as any).store ??= new Map<string, any>())
    if (opts.honorsKey && key && store.has(key)) return send(res, 200, store.get(key), { 'Idempotent-Replayed': 'true' })
    mock.effects.push({ body, key })
    const out = { received: true, n: mock.effects.length }
    if (key) store.set(key, out)
    if (maybeDrop(mock, res)) return
    send(res, 200, out)
  })

export const slackMock = (opts: { history: boolean }) =>
  listen((req, res, body, mock) => {
    if (req.headers.authorization !== 'Bearer xoxb-mock') return send(res, 200, { ok: false, error: 'invalid_auth' })
    const b = JSON.parse(body || '{}')
    if (req.url === '/chat.postMessage') {
      const m = { ts: `1700000000.${String(mock.effects.length + 1).padStart(6, '0')}`, text: b.text, channel: b.channel, metadata: b.metadata }
      mock.effects.push(m)
      if (maybeDrop(mock, res)) return
      return send(res, 200, { ok: true, ts: m.ts, channel: b.channel })
    }
    if (req.url === '/conversations.history' || req.url === '/conversations.replies') {
      if (!opts.history) return send(res, 200, { ok: false, error: 'missing_scope' })
      return send(res, 200, { ok: true, messages: mock.effects.filter((m) => m.channel === b.channel).reverse() })
    }
    send(res, 404, { ok: false, error: 'unknown_method' })
  })

export const githubMock = () =>
  listen((req, res, body, mock) => {
    if (req.headers.authorization !== 'Bearer ghp_mock') return send(res, 401, { message: 'Bad credentials' })
    const url = new URL(req.url!, 'http://x')
    const issue = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/)
    const comments = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/)
    if (req.method === 'POST' && (issue || comments)) {
      const b = JSON.parse(body)
      const e = { kind: issue ? 'issue' : 'comment', repo: (issue ?? comments)![1], number: issue ? mock.effects.filter((x) => x.kind === 'issue').length + 1 : Number(comments![2]), id: mock.effects.length + 100, body: b.body, title: b.title }
      mock.effects.push(e)
      if (maybeDrop(mock, res)) return
      return send(res, 201, { ...e, html_url: `https://github.example/${e.repo}/issues/${e.number}` })
    }
    if (req.method === 'GET' && (issue || comments)) {
      if ((mock as any).listBroken) return send(res, 500, { message: 'down' })
      const kind = issue ? 'issue' : 'comment'
      const items = mock.effects.filter((e) => e.kind === kind && e.repo === (issue ?? comments)![1]).reverse()
      return send(res, 200, items.map((e) => ({ ...e, html_url: `https://github.example/${e.repo}/issues/${e.number}` })))
    }
    send(res, 404, { message: 'Not Found' })
  })

export interface SmtpMock {
  port: number
  messages: { from: string; to: string[]; data: string }[]
  /** Accept the next N messages, then close the connection instead of sending 250. */
  dropAfterData: number
  close: () => Promise<void>
}

export async function smtpMock(): Promise<SmtpMock> {
  const mock: SmtpMock = { port: 0, messages: [], dropAfterData: 0, close: async () => {} }
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = ''
    let inData = false
    let cur = { from: '', to: [] as string[], data: '' }
    sock.write('220 mock ESMTP\r\n')
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          cur.data = buf.slice(0, end)
          buf = buf.slice(end + 5)
          inData = false
          mock.messages.push(cur)
          cur = { from: '', to: [], data: '' }
          if (mock.dropAfterData > 0) { mock.dropAfterData--; sock.destroy(); return }
          sock.write('250 queued\r\n')
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (/^EHLO/i.test(line)) sock.write('250-mock\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN/i.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString().includes('\0user\0pass') ? '235 ok\r\n' : '535 no\r\n')
        else if (/^MAIL FROM/i.test(line)) { cur.from = line.slice(10); sock.write('250 ok\r\n') }
        else if (/^RCPT TO:<bad@/i.test(line)) sock.write('550 no such user\r\n')
        else if (/^RCPT TO/i.test(line)) { cur.to.push(line.slice(8)); sock.write('250 ok\r\n') }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n') }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n')
        else sock.write('500 what\r\n')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.port = (server.address() as net.AddressInfo).port
  mock.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) })
  return mock
}
