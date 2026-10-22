import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'

/** The visitor's id: a random cookie, so each browser gets its own agent and inbox. */
export async function visitor(): Promise<string> {
  const jar = await cookies()
  const have = jar.get('sa_sid')?.value
  if (have && /^[a-z0-9]{12,40}$/.test(have)) return have
  const id = randomBytes(9).toString('hex')
  jar.set('sa_sid', id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 })
  return id
}
