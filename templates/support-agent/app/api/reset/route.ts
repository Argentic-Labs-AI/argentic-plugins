import { visitor } from '@/lib/http'
import { freshSession, saveSession, view } from '@/lib/session'
import { store } from '@/lib/store'

export const dynamic = 'force-dynamic'

export async function POST() {
  const sid = await visitor()
  const s = freshSession(sid)
  await store().set(`kill:${sid}`, 0)
  await saveSession(store(), s)
  return Response.json(view(s))
}
