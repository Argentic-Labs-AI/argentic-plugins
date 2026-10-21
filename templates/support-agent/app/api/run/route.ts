import { delayMs } from '@/lib/config'
import { visitor } from '@/lib/http'
import { runSession } from '@/lib/run'
import { loadSession } from '@/lib/session'
import { store } from '@/lib/store'
import { hintFor } from '@argentic-labs/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Streams one JSON object per line: the run's state after every change. */
export async function POST(req: Request) {
  const sid = await visitor()
  const apiKey = process.env.ARGENTIC_API_KEY
  const modelKey = req.headers.get('x-model-key')?.trim() || process.env.MODEL_KEY
  if (!apiKey) return Response.json({ error: 'ARGENTIC_API_KEY is not set on this deployment. See the README.' }, { status: 503 })
  if (!modelKey) return Response.json({ error: 'Paste your model key first. It is sent with this request and never stored.' }, { status: 400 })

  // A run that was just killed may still be writing its last line. Let it finish before the next one starts.
  const s = store()
  for (let i = 0; i < 40; i++) {
    const cur = await loadSession(s, sid)
    if (cur.status !== 'running' || Date.now() - cur.beat > 10_000) break
    await sleep(250)
  }

  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      const send = (v: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(v) + '\n'))
        } catch {
          /* the browser has gone: the run carries on to its next kill check */
        }
      }
      try {
        await runSession({ store: s, sid, apiKey, modelKey, baseUrl: process.env.ARGENTIC_BASE_URL, delayMs: delayMs(), signal: req.signal, emit: (v) => send(v) })
        send({ done: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        send({ error: `${msg}${hintFor(e) ? `\n${hintFor(e)}` : ''}` })
      }
      try {
        controller.close()
      } catch {}
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
}
