// The durable loop: wake the agent, carry out the actions it asks for, hand the results back.
// It is the same shape as runDurable in @argentic-labs/client, with two differences a web app needs:
// the ledger lives in the state store (not a local file), and a Kill can stop it between any two awaits.
import { Argentic, freeModel, toArgenticSchema, type ModelSpec, type ToolDecl } from '@argentic-labs/client'
import { fromAiSdkTools } from '@argentic-labs/client/ai-sdk'
import { killKey, loadSession, saveSession, view, type LineKind, type Session, type View } from './session'
import type { Store } from './store'
import { Killed, makeTools, system, task } from './tools'

export interface RunInput {
  store: Store
  sid: string
  apiKey: string
  modelKey?: string
  baseUrl?: string
  model?: ModelSpec
  delayMs?: number
  maxSteps?: number
  /** Aborts when the browser goes away (Kill, closed tab). Counts as a kill, like the flag in the store. */
  signal?: AbortSignal
  /** Called with the new state after every change. */
  emit?: (v: View) => void
  fetch?: typeof fetch
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9\-_.:]/g, '-').slice(0, 128)

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSpec {
  if (!env.ARGENTIC_MODEL_ID) return freeModel
  return {
    provider: env.ARGENTIC_MODEL_PROVIDER ?? freeModel.provider,
    id: env.ARGENTIC_MODEL_ID,
    prices: { in: Number(env.ARGENTIC_PRICE_IN ?? 0), out: Number(env.ARGENTIC_PRICE_OUT ?? 0) },
  }
}

export async function runSession(input: RunInput): Promise<View> {
  const { store, sid } = input
  const delayMs = input.delayMs ?? 2500
  const session: Session = await loadSession(store, sid)
  if (session.status === 'done') return view(session)

  session.attempt += 1
  const mine = session.attempt
  const resuming = session.wakes.length > 0
  session.status = 'running'

  const push = (kind: LineKind, text: string) => {
    session.log.push({ at: new Date().toISOString(), kind, text })
    if (session.log.length > 80) session.log.splice(0, session.log.length - 80)
    input.emit?.(view(session))
  }
  const save = () => saveSession(store, session)

  // Kill is a flag in the store, so it works when the Kill request lands on another server instance.
  const killed = async () => Boolean(input.signal?.aborted) || ((await store.get<number>(killKey(sid))) ?? 0) >= mine
  const work = async (ms: number) => {
    for (let left = ms; left > 0; left -= 150) {
      await sleep(Math.min(150, left))
      if (await killed()) throw new Killed()
    }
    if (await killed()) throw new Killed()
  }

  const finishedBefore = Object.keys(session.ledger).length
  push('info', resuming ? `Resumed from the journal: ${finishedBefore} action${finishedBefore === 1 ? '' : 's'} had finished before the kill.` : 'Starting the run.')
  await save()

  const client = new Argentic({ apiKey: input.apiKey, modelKey: input.modelKey, baseUrl: input.baseUrl, fetch: input.fetch })
  const tools = await fromAiSdkTools(makeTools({ session, save, work, delayMs, log: (k, t) => push(k, t) }))
  const byName = new Map(tools.map((t) => [t.name, t]))
  const decls: ToolDecl[] = tools.map(({ name, description, parameters }) => ({
    name,
    description: description || name,
    parameters: toArgenticSchema(parameters),
  }))
  const model = input.model ?? modelFromEnv()

  try {
    let message = task
    for (let step = 0; step < (input.maxSteps ?? 8); step++) {
      if (await killed()) throw new Killed()
      push('info', `Turn ${step + 1}: asking the model…`)
      const res = await client.wake(session.agent, { message, model, system, tools: decls }, safeKey(`${session.runId}.${step}`))
      if (!session.wakes.includes(res.wake_id)) session.wakes.push(res.wake_id)
      session.spentUsd = Math.round((session.spentUsd + (res.spent_usd ?? 0)) * 1e6) / 1e6
      push('wake', res.idempotentReplay ? `Turn ${step + 1}: this answer was already in the journal, so the model was not called again.` : `Turn ${step + 1}: the model answered (${res.status}).`)
      await save()
      if (await killed()) throw new Killed()

      const actions = res.actions ?? []
      const results: { tool: string; seq: number; result: unknown }[] = []
      for (const action of actions) {
        const ledgerKey = `${session.agent}:${action.seq}`
        const done = session.ledger[ledgerKey]
        if (done) {
          push('skip', `${action.tool} had finished before the kill, so it was skipped.`)
          results.push({ tool: action.tool, seq: action.seq, result: done.result })
          continue
        }
        const tool = byName.get(action.tool)
        let result: unknown
        if (!tool) result = { error: 'unknown tool' }
        else {
          push('info', `${action.tool}: working…`)
          try {
            result = await tool.execute(action.args ?? {}, { seq: action.seq, idempotencyKey: ledgerKey })
          } catch (e) {
            if (e instanceof Killed) throw e
            result = { error: e instanceof Error ? e.message : String(e) }
          }
        }
        session.ledger[ledgerKey] = { tool: action.tool, result: result ?? null, at: new Date().toISOString() }
        push('ran', `${action.tool}: done.`)
        await save()
        results.push({ tool: action.tool, seq: action.seq, result: result ?? null })
        if (await killed()) throw new Killed()
      }

      session.reply = res.reply ?? ''
      if (actions.length === 0 || res.status !== 'done') {
        session.status = res.status === 'done' ? 'done' : 'error'
        if (res.status !== 'done') push('error', `The run stopped with status ${res.status}${res.error ? `: ${res.error}` : ''}. Press Resume to carry on.`)
        break
      }
      message = 'Results of the tools you asked for:\n' + JSON.stringify(results)
    }
    if (session.status === 'running') session.status = 'done'
    if (session.status === 'done') push('done', session.reply ? `Finished: ${session.reply}` : 'Finished.')
  } catch (e) {
    if (e instanceof Killed) {
      session.status = 'killed'
      push('kill', 'Killed. Nothing after this point ran. Press Resume to carry on from the journal.')
    } else {
      session.status = 'error'
      push('error', e instanceof Error ? e.message : String(e))
      await save()
      throw e
    }
  }
  await save()
  return view(session)
}
