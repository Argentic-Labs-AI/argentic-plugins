// Vercel AI SDK (v5/v6) on-ramp: your tool() objects become Argentic tools.
// Only the tools carry over. Argentic runs the loop, not generateText or Agent.
import { asSchema, type ToolSet } from 'ai'
import type { DurableTool } from './argentic.ts'

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === 'object' && v !== null && Symbol.asyncIterator in v

/** The tool name is the ToolSet key. Async because a JSON schema may be a promise. */
export async function fromAiSdkTools(tools: ToolSet): Promise<DurableTool[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, t]): Promise<DurableTool> => {
      const parameters = (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown>
      return {
        name,
        description: t.description ?? '',
        parameters,
        execute: async (args, ctx) => {
          if (!t.execute) return { error: `tool ${name} has no execute function` }
          let out: unknown = await t.execute(args, { toolCallId: ctx.idempotencyKey, messages: [] })
          // A streaming tool yields many values; the last one is its result.
          if (isAsyncIterable(out)) {
            let last: unknown
            for await (const part of out) last = part
            out = last
          }
          return out
        },
      }
    }),
  )
}
