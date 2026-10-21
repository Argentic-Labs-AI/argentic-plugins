// Where a visitor's run lives between requests. Upstash Redis when its env vars are set,
// otherwise a JSON file in the temp folder (fine locally; on Vercel it can vanish between requests).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
}

const safe = (key: string) => key.replace(/[^A-Za-z0-9:_-]/g, '_')
const TTL_SECONDS = 24 * 60 * 60

function redisStore(url: string, token: string, doFetch: typeof fetch): Store {
  const call = async (path: string, init?: RequestInit) => {
    const res = await doFetch(`${url.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`state store answered ${res.status}`)
    return (await res.json()) as { result: string | null }
  }
  return {
    async get<T>(key: string) {
      const { result } = await call(`/get/${safe(key)}`)
      return result == null ? undefined : (JSON.parse(result) as T)
    },
    async set(key, value) {
      await call(`/set/${safe(key)}?EX=${TTL_SECONDS}`, { method: 'POST', body: JSON.stringify(value) })
    },
  }
}

function fileStore(dir: string): Store {
  const path = (key: string) => join(dir, `${safe(key)}.json`)
  return {
    async get<T>(key: string) {
      try {
        return JSON.parse(await readFile(path(key), 'utf8')) as T
      } catch {
        return undefined
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true })
      const tmp = `${path(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, JSON.stringify(value))
      await rename(tmp, path(key))
    },
  }
}

export function makeStore(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN
  if (url && token) return redisStore(url, token, fetch)
  return fileStore(join(tmpdir(), 'argentic-support-agent'))
}

export const usingRedis = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean((env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL) && (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN))

let shared: Store | undefined
export const store = (): Store => (shared ??= makeStore())
