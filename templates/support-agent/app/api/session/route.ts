import { setup } from '@/lib/config'
import { visitor } from '@/lib/http'
import { loadSession, view } from '@/lib/session'
import { store } from '@/lib/store'

export const dynamic = 'force-dynamic'

export async function GET() {
  const sid = await visitor()
  return Response.json({ ...view(await loadSession(store(), sid)), setup: setup() })
}
