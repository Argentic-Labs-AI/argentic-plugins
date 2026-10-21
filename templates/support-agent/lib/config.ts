import { usingRedis } from './store'

export const dashboardUrl = () => (process.env.ARGENTIC_DASHBOARD_URL ?? 'https://getargentic.com').replace(/\/+$/, '')
export const delayMs = () => Number(process.env.ACTION_DELAY_MS ?? 2500)

/** What the page needs to know about this deployment, never a key. */
export const setup = () => ({
  hasApiKey: Boolean(process.env.ARGENTIC_API_KEY),
  hasModelKey: Boolean(process.env.MODEL_KEY),
  persistent: usingRedis(),
})
