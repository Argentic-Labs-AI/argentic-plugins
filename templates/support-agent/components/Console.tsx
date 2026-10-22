'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cpu, Inbox, Loader2, Mail, OctagonX, Play, RotateCcw, ShieldCheck, SkipForward } from 'lucide-react'

type LineKind = 'info' | 'wake' | 'ran' | 'skip' | 'dup' | 'kill' | 'done' | 'error'
interface Line { at: string; kind: LineKind; text: string }
interface Email { key: string; to: string; subject: string; body: string; at: string }
interface View {
  status: 'idle' | 'running' | 'killed' | 'done' | 'error'
  agent: string
  wakes: string[]
  log: Line[]
  outbox: Email[]
  finished: number
  reply?: string
  spentUsd: number
}
interface Setup { hasApiKey: boolean; hasModelKey: boolean; persistent: boolean }
interface Proof { wakes: { id: string; turns: number; mismatched: number; unverifiable: number }[]; link: string | null; error?: string }

const empty: View = { status: 'idle', agent: '', wakes: [], log: [], outbox: [], finished: 0, spentUsd: 0 }
const KEY_STORE = 'support-agent-model-key'

const icons: Record<LineKind, React.ReactNode> = {
  info: <span className="mt-[7px] block size-1.5 rounded-full bg-muted/60" />,
  wake: <Cpu className="size-4 text-muted" />,
  ran: <Check className="size-4 text-good" />,
  skip: <SkipForward className="size-4 text-muted" />,
  dup: <ShieldCheck className="size-4 text-good" />,
  kill: <OctagonX className="size-4 text-bad" />,
  done: <Check className="size-4 text-good" />,
  error: <OctagonX className="size-4 text-bad" />,
}

const btn =
  'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium sm:h-10 disabled:cursor-not-allowed disabled:border disabled:border-line disabled:bg-panel disabled:text-muted'
const primary = `${btn} bg-fg text-[var(--accent-fg)] hover:opacity-85`
const secondary = `${btn} border border-line hover:bg-panel`

export function Console() {
  const [v, setV] = useState<View>(empty)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [proof, setProof] = useState<Proof | null>(null)
  const [proofBusy, setProofBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const r = await fetch('/api/session', { cache: 'no-store' })
    const j = (await r.json()) as View & { setup: Setup }
    setSetup(j.setup)
    setV(j)
    return j
  }, [])

  useEffect(() => {
    try {
      setModelKey(sessionStorage.getItem(KEY_STORE) ?? '')
    } catch {}
    refresh().catch(() => setError('Could not reach the server.'))
  }, [refresh])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [v.log.length])

  const keyNeeded = setup ? !setup.hasModelKey : false
  const canRun = Boolean(setup?.hasApiKey) && (!keyNeeded || modelKey.trim().length > 0)
  const stopped = v.status === 'killed' || v.status === 'error' || (v.status === 'running' && !running)
  const resumable = v.wakes.length > 0 && v.status !== 'done'

  async function run() {
    setError('')
    setProof(null)
    const ctl = new AbortController()
    abort.current = ctl
    setRunning(true)
    try {
      const res = await fetch('/api/run', { method: 'POST', headers: modelKey.trim() ? { 'x-model-key': modelKey.trim() } : {}, signal: ctl.signal })
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `The server answered ${res.status}.`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line) continue
          const msg = JSON.parse(line) as View & { error?: string; done?: boolean }
          if (msg.error) setError(msg.error)
          else if (msg.status) setV(msg)
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    } finally {
      setRunning(false)
      abort.current = null
      await refresh().catch(() => {})
    }
  }

  async function kill() {
    await fetch('/api/kill', { method: 'POST' })
    abort.current?.abort()
    // The server writes its last line a moment later. Wait for it so Resume starts from the saved state.
    for (let i = 0; i < 20; i++) {
      const j = await refresh().catch(() => null)
      if (j && j.status !== 'running') break
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async function reset() {
    setError('')
    setProof(null)
    const r = await fetch('/api/reset', { method: 'POST' })
    setV((await r.json()) as View)
  }

  async function checkProof() {
    setProofBusy(true)
    try {
      setProof((await (await fetch('/api/proof', { cache: 'no-store' })).json()) as Proof)
    } finally {
      setProofBusy(false)
    }
  }

  const sent = v.outbox.length

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">A support agent you can kill mid-run</h1>
        <p className="max-w-[60ch] text-pretty text-base leading-relaxed text-muted">
          It reads a ticket, looks up the order and sends one email to the customer. Press Kill while it works, then Resume. The email count stays at one.
        </p>
      </header>

      {setup && !setup.hasApiKey && (
        <div role="alert" className="rounded-2xl border border-line bg-panel p-4 text-sm leading-relaxed">
          This deployment has no <code className="font-mono text-[13px]">ARGENTIC_API_KEY</code>. Make a key at{' '}
          <a className="underline underline-offset-4" href="https://getargentic.com/platform" target="_blank" rel="noreferrer">getargentic.com/platform ↗</a>, add it as an environment variable and redeploy.
        </div>
      )}

      {keyNeeded && (
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Your model key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="nvapi-…"
            value={modelKey}
            onChange={(e) => {
              setModelKey(e.target.value)
              try {
                sessionStorage.setItem(KEY_STORE, e.target.value)
              } catch {}
            }}
            className="h-11 w-full max-w-[520px] rounded-xl border border-line bg-bg px-4 font-mono text-[13px] outline-none placeholder:text-muted focus-visible:border-fg"
          />
          <span className="max-w-[60ch] text-muted">
            The default model is free on NVIDIA: get a key at{' '}
            <a className="underline underline-offset-4" href="https://build.nvidia.com" target="_blank" rel="noreferrer">build.nvidia.com ↗</a>. It stays in this tab and is forwarded to Argentic with each call. This app does not store it, and neither does Argentic.
          </span>
        </label>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="run-h" className="flex min-w-0 flex-col gap-5 rounded-[20px] border border-line p-5 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 id="run-h" className="text-lg font-semibold tracking-tight">The ticket</h2>
            <div className="rounded-2xl bg-panel p-4 text-sm leading-relaxed">
              <p className="font-medium">Order 1182 arrived broken</p>
              <p className="text-muted">dana@example.com</p>
              <p className="mt-2">Hi, my pour-over set from order 1182 arrived with a cracked dripper. Can you fix this? Thanks, Dana</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!running && v.status !== 'done' && (
              <button className={primary} onClick={run} disabled={!canRun}>
                <Play className="size-4" aria-hidden />
                {resumable || stopped ? 'Resume' : 'Run agent'}
              </button>
            )}
            {running && (
              <button className={`${btn} border border-bad text-bad hover:bg-bad/10`} onClick={kill}>
                <OctagonX className="size-4" aria-hidden />
                Kill
              </button>
            )}
            {(v.status === 'done' || v.status === 'killed' || v.status === 'error') && !running && (
              <button className={secondary} onClick={reset}>
                <RotateCcw className="size-4" aria-hidden />
                Start over
              </button>
            )}
            <span className="basis-full text-sm text-muted sm:basis-auto" aria-live="polite">
              {running
                ? 'Running. Press Kill any time.'
                : v.status === 'killed'
                  ? sent > 0
                    ? `Killed. ${sent} email${sent === 1 ? ' is' : 's are'} already out. Resume will not send ${sent === 1 ? 'it' : 'them'} again.`
                    : 'Killed before anything went out. Press Resume.'
                  : v.status === 'done'
                    ? 'Finished.'
                    : !canRun && setup
                      ? setup.hasApiKey ? 'Add your model key above to start.' : 'Set ARGENTIC_API_KEY to start.'
                      : ''}
            </span>
            <p className="basis-full text-sm text-muted lg:hidden">
              <span className={`text-2xl font-semibold tabular-nums ${sent > 1 ? 'text-bad' : 'text-fg'}`}>{sent}</span> email{sent === 1 ? '' : 's'} sent
            </p>
          </div>

          {error && (
            <div role="alert" className="whitespace-pre-line rounded-2xl border border-bad/40 p-4 text-sm leading-relaxed text-bad">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted">What happened</h3>
            <ol className="flex flex-col gap-2.5 lg:max-h-[520px] lg:overflow-y-auto lg:pr-1" aria-label="Run log">
              {v.log.length === 0 &&
                ['Look up order 1182', 'Send one email to the customer', 'Reply with a one-line summary'].map((t) => (
                  <li key={t} className="flex items-start gap-3 text-sm leading-relaxed text-muted">
                    <span className="mt-[7px] block size-1.5 shrink-0 rounded-full border border-muted/60" />
                    {t}
                  </li>
                ))}
              {v.log.map((l, i) => {
                const last = i === v.log.length - 1
                const resumed = l.text.startsWith('Resumed from the journal')
                return (
                  <li
                    key={`${l.at}-${i}`}
                    className={`rise flex items-start gap-3 text-sm leading-relaxed ${resumed ? 'mt-2 border-t border-line pt-4' : ''} ${l.kind === 'dup' ? '-mx-3 rounded-xl bg-good/10 px-3 py-2 font-medium' : ''}`}
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-start justify-center">
                      {running && last && l.text.endsWith('working…') ? <Loader2 className="size-4 animate-spin text-muted" aria-hidden /> : icons[l.kind]}
                    </span>
                    <span className={l.kind === 'kill' || l.kind === 'error' ? 'text-bad' : l.kind === 'dup' ? 'text-good' : ''}>{l.text}</span>
                  </li>
                )
              })}
              <div ref={logEnd} />
            </ol>
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="inbox-h" className="flex flex-col gap-4 rounded-[20px] border border-line p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="inbox-h" className="text-lg font-semibold tracking-tight">Sandbox inbox</h2>
              <p className="hidden text-sm text-muted lg:block">
                <span className={`text-5xl font-semibold leading-none tabular-nums ${sent > 1 ? 'text-bad' : 'text-fg'}`}>{sent}</span> email{sent === 1 ? '' : 's'} sent
              </p>
            </div>
            {v.log.some((l) => l.kind === 'dup') && (
              <p className="rounded-xl bg-good/10 px-3 py-2 text-sm font-medium text-good">Resume tried to send again. The same key blocked it.</p>
            )}
            {sent === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl bg-panel p-4 text-sm text-muted">
                <Inbox className="size-4" aria-hidden />
                No mail yet. Nothing here goes to a real address.
              </div>
            ) : (
              v.outbox.map((m) => (
                <article key={m.key} className="rise flex flex-col gap-1 rounded-2xl bg-panel p-4 text-sm leading-relaxed">
                  <p className="flex items-center gap-2 text-muted"><Mail className="size-4" aria-hidden /> to {m.to}</p>
                  <p className="font-medium">{m.subject}</p>
                  <p className="whitespace-pre-line">{m.body}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">key {m.key}</p>
                </article>
              ))
            )}
          </section>

          <section aria-labelledby="proof-h" className="flex flex-col gap-3 rounded-[20px] border border-line p-5 sm:p-6">
            <h2 id="proof-h" className="text-lg font-semibold tracking-tight">Proof of what ran</h2>
            <p className="text-sm leading-relaxed text-muted">
              Replays every model call from the journal and checks it matches what was sent. Free.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button className={secondary} onClick={checkProof} disabled={proofBusy || v.wakes.length === 0 || running}>
                <ShieldCheck className="size-4" aria-hidden />
                {proofBusy ? 'Checking…' : 'Check'}
              </button>
              {v.wakes.length === 0 && <span className="text-sm text-muted">Run the agent first.</span>}
              {proof?.link && (
                <a className="text-sm underline underline-offset-4" href={proof.link} target="_blank" rel="noreferrer">
                  Open this run in the dashboard ↗
                </a>
              )}
            </div>
            {proof?.error && <p className="text-sm text-bad">{proof.error}</p>}
            {proof && !proof.error && (
              <p className={`text-sm font-medium ${proof.wakes.every((w) => w.mismatched === 0 && w.unverifiable === 0) ? 'text-good' : 'text-warn'}`}>
                {proof.wakes.filter((w) => w.mismatched === 0 && w.unverifiable === 0).length} of {proof.wakes.length} wakes match the journal
              </p>
            )}
            {proof && !proof.error && (
              <ul className="flex flex-col gap-1.5 text-sm" aria-label="Replay results">
                {proof.wakes.map((w) => {
                  const ok = w.mismatched === 0 && w.unverifiable === 0
                  return (
                    <li key={w.id} className="rise flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[12px] text-muted">{w.id}</span>
                      <span className={ok ? 'text-good' : 'text-warn'}>{ok ? 'all match' : `${w.mismatched} differ, ${w.unverifiable} not checkable`}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      <footer className="flex flex-col gap-1 text-sm text-muted">
        <p>
          Argentic runs the agent loop; the tools are plain Vercel AI SDK <code className="font-mono text-[13px]">tool()</code> objects.{' '}
          <a className="underline underline-offset-4" href="https://getargentic.com/docs/frameworks/ai-sdk" target="_blank" rel="noreferrer">AI SDK guide ↗</a>
        </p>
        {setup && !setup.persistent && (
          <p>State is kept in this server&apos;s temp folder. Add the Upstash Redis integration so a resume still finds it on Vercel.</p>
        )}
      </footer>
    </div>
  )
}
