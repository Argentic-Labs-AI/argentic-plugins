import { usingRedis } from './store'

export const dashboardUrl = () => (process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')
/** MODEL_KEY is a convenience for `npm run dev`. On a deployed site only the visitor's own key is used, so nobody can spend yours. */
export const sharedModelKey = () => (process.env.NODE_ENV === 'production' ? undefined : process.env.MODEL_KEY)
export const delayMs = () => Number(process.env.ACTION_DELAY_MS ?? 2500)

/** What the page needs to know about this deployment, never a key. */
export const setup = () => ({
  hasApiKey: Boolean(process.env.ARGENTIC_API_KEY),
  hasModelKey: Boolean(sharedModelKey()),
  persistent: usingRedis(),
})
