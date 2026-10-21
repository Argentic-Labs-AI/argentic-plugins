// Mastra on-ramp: your createTool() tools become Argentic tools.
// Only the tools carry over. Argentic runs the loop, not Agent.generate or Agent.stream.
import type { DurableTool } from './argentic.ts'

type Standard = {
  validate: (v: unknown) => unknown
  jsonSchema?: { input: (o: { target: string }) => Record<string, unknown> }
}
// Structural, so this file needs no @mastra/core import and tracks createTool's shape.
interface MastraToolLike {
  description?: string
  inputSchema?: unknown
  execute?: (input: any, context: any) => Promise<unknown>
}

/** The tool name is the key, as when you pass `tools` to an Agent. */
export function fromMastraTools(tools: Record<string, MastraToolLike>): DurableTool[] {
  return Object.entries(tools).map(([name, t]): DurableTool => {
    const std = (t.inputSchema as { '~standard'?: Standard } | undefined)?.['~standard']
    const parameters = std?.jsonSchema?.input({ target: 'draft-07' }) ?? { type: 'object', properties: {} }
    return {
      name,
      description: t.description ?? '',
      parameters,
      execute: async (args, ctx) => {
        if (!t.execute) return { error: `tool ${name} has no execute function` }
        if (std) {
          const checked = (await std.validate(args)) as { issues?: readonly { message: string }[] }
          if (checked.issues?.length) return { error: `invalid input: ${checked.issues.map((i) => i.message).join('; ')}` }
        }
        // The action's idempotency key is the tool call id, as agent.toolCallId is in a Mastra run.
        return t.execute(args, { agent: { toolCallId: ctx.idempotencyKey, messages: [] } })
      },
    }
  })
}
