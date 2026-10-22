// The agent's tools, written as Vercel AI SDK tool() objects. @argentic-labs/client/ai-sdk turns them into
// Argentic tools: Argentic runs the loop and asks this code to carry out each action.
import { tool } from 'ai'
import { z } from 'zod'
import type { Email, Session } from './session'

export class Killed extends Error {
  constructor() {
    super('killed')
  }
}

export const orders: Record<string, { customer: string; email: string; item: string; total_usd: number; status: string }> = {
  '1182': { customer: 'Dana Whitfield', email: 'dana@example.com', item: 'Ceramic pour-over set', total_usd: 42, status: 'delivered, reported broken' },
}

export interface ToolEnv {
  session: Session
  /** Persist the session right now (the sandbox provider has taken the message). */
  save: () => Promise<void>
  /** Resolves after ms; rejects with Killed if the visitor pressed Kill meanwhile. */
  work: (ms: number) => Promise<void>
  delayMs: number
  log: (kind: 'info' | 'dup', text: string) => void
}

/** The sandbox mail provider. A real one (Resend, Postmark, SES) takes an idempotency key the same way. */
export async function deliver(env: ToolEnv, mail: Omit<Email, 'at'>): Promise<{ sent: true; to: string; duplicate: boolean }> {
  const seen = env.session.outbox.some((m) => m.key === mail.key)
  if (!seen) {
    env.session.outbox.push({ ...mail, at: new Date().toISOString() })
    await env.save()
  }
  // The provider answers a moment later. Press Kill in this gap and the message has already left.
  await env.work(env.delayMs)
  if (seen) env.log('dup', `send_email ran again with the same key. The mail provider already had it, so it did not send again.`)
  return { sent: true, to: mail.to, duplicate: seen }
}

export function makeTools(env: ToolEnv) {
  return {
    lookup_order: tool({
      description: 'Look up an order by its number.',
      inputSchema: z.object({ order_id: z.string().describe('The order number, digits only') }),
      execute: async ({ order_id }) => {
        await env.work(env.delayMs / 2)
        const order = orders[order_id.replace(/\D/g, '')]
        return order ? { found: true, order_id, ...order } : { found: false, order_id }
      },
    }),
    send_email: tool({
      description: 'Send one email to a customer. The customer sees exactly this subject and body.',
      // Properties are listed shortest name first. Argentic stores a run's tools as jsonb, which sorts keys that way, and Check
      // re-renders the prompt from that copy: written in another order, the tools would replay as a different prompt.
      inputSchema: z.object({ to: z.string(), body: z.string(), subject: z.string() }),
      // toolCallId is the action's stable key, `${agent}:${seq}`, the same on every retry.
      execute: async (args, { toolCallId }) => deliver(env, { key: toolCallId, ...args }),
    }),
  }
}

export const system =
  'You are a customer support agent. Tool calls are requests: their outcomes arrive in the next message. ' +
  'Call one tool per turn. Send exactly one email to the customer, and only after looking up the order. ' +
  'When the email is sent, reply with a one-line summary and no tool call.'

export const ticket = {
  from: 'dana@example.com',
  subject: 'Order 1182 arrived broken',
  body: 'Hi, my pour-over set from order 1182 arrived with a cracked dripper. Can you fix this? Thanks, Dana',
}

export const task =
  `New support ticket from ${ticket.from}, subject "${ticket.subject}":\n\n${ticket.body}\n\n` +
  'Look up the order, then email the customer: apologise, say a replacement ships today, and keep it under 80 words.'
