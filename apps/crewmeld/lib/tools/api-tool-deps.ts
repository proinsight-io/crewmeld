import { db, tools } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { resolveCredentialById } from '@/lib/connectors/resolver'
import { runApiTool } from './api-tool-runner'
import type { ApiToolRunnerDeps, ApiToolSpec } from './api-tool-types'

/**
 * Build production dependency wiring for {@link runApiTool} (DB-backed).
 *
 * @param callStack - Tool ids already on the current call stack, used for
 *   cycle detection when an api tool invokes another tool via `callTool`.
 */
export function buildApiToolDeps(callStack: string[] = []): ApiToolRunnerDeps {
  return {
    resolveConnection: async (connectionId) => {
      const cred = await resolveCredentialById(connectionId)
      if (!cred) return null
      return { type: cred.type, config: cred.config }
    },
    invokeTool: async (toolId, input) => {
      const [row] = await db
        .select({ kind: tools.kind, apiSpec: tools.apiSpec })
        .from(tools)
        .where(eq(tools.id, toolId))
        .limit(1)
      if (!row || row.kind !== 'api' || !row.apiSpec) {
        throw new Error(`callTool target is not an api tool: ${toolId}`)
      }
      const r = await runApiTool(
        row.apiSpec as ApiToolSpec,
        input,
        buildApiToolDeps([...callStack, toolId]),
        { callStack: [...callStack, toolId], toolId }
      )
      if (!r.success) throw new Error(r.error)
      return r.result
    },
  }
}
