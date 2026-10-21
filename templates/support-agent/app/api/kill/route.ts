import { visitor } from '@/lib/http'
import { killKey, loadSession } from '@/lib/session'
import { store } from '@/lib/store'

export const dynamic = 'force-dynamic'

export async function POST() {
  const sid = await visitor()
  const s = await loadSession(store(), sid)
  // Anything running now has attempt === s.attempt; the loop checks this flag between steps.
  await store().set(killKey(sid), s.attempt)
  return Response.json({ killed: s.attempt })
}
