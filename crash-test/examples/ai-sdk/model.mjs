// A scripted stand-in for the model, so these examples need no API key and no network. It asks for the three tools in order, one
// per step, then replies. To try a real model, delete this file's import in naive.mjs / safe.mjs and pass your own, for example
//   import { openai } from '@ai-sdk/openai'   ...   model: openai('gpt-5-mini')
import { MockLanguageModelV3 } from 'ai/test'

const steps = [
  ['refund_order', { order_id: '1182', amount_usd: 42 }],
  ['send_email', { to: 'dana@example.com', subject: 'Your refund', body: 'Your refund is on its way.' }],
  ['close_ticket', { ticket_id: 'T-77', note: 'Refunded and emailed.' }],
]
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

export const scriptedModel = () =>
  new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      // The step to take is however many tool results the conversation already holds.
      const next = steps[prompt.filter((m) => m.role === 'tool').length]
      const content = next
        ? [{ type: 'tool-call', toolCallId: `call_${next[0]}`, toolName: next[0], input: JSON.stringify(next[1]) }]
        : [{ type: 'text', text: 'Refunded $42, emailed Dana and closed T-77.' }]
      return { content, finishReason: { unified: next ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] }
    },
  })
