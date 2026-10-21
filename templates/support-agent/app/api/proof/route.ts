import { dashboardUrl } from '@/lib/config'
import { visitor } from '@/lib/http'
import { loadSession } from '@/lib/session'
import { store } from '@/lib/store'
import { Argentic, hintFor } from '@argentic-labs/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Re-renders each prompt from the journal and compares it with what the model was sent. Costs nothing. */
export async function GET() {
  const sid = await visitor()
  const apiKey = process.env.ARGENTIC_API_KEY
  if (!apiKey) return Response.json({ error: 'ARGENTIC_API_KEY is not set' }, { status: 503 })
  const s = await loadSession(store(), sid)
  if (s.wakes.length === 0) return Response.json({ wakes: [], link: null })
  const client = new Argentic({ apiKey, baseUrl: process.env.ARGENTIC_BASE_URL })
  try {
    const wakes = []
    for (const id of s.wakes) {
      const r = await client.replay(s.agent, id)
      wakes.push({ id, turns: r.turns.length, mismatched: r.mismatched, unverifiable: r.unverifiable })
    }
    return Response.json({ wakes, link: `${dashboardUrl()}/platform/runs/${encodeURIComponent(s.agent)}/${encodeURIComponent(s.wakes[0])}` })
  } catch (e) {
    return Response.json({ error: `${e instanceof Error ? e.message : String(e)}${hintFor(e) ? ` ${hintFor(e)}` : ''}` }, { status: 502 })
  }
}
