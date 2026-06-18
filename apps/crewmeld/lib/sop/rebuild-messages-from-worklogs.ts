/**
 * Rebuild a suspended node's LLM conversation from its `work_logs` (IO wrapper).
 *
 * When a digital-employee node suspends on an async tool, we do NOT persist the
 * raw OpenAI message array. Instead every tool call is already journaled to
 * `work_logs` (one row per call, keyed by the node's `taskId`). On resume we
 * replay those rows — grouped by LLM round — into the assistant(tool_calls) +
 * tool(result) message pairs the model expects, then continue the loop from the
 * next round. The system + user head of the conversation is rebuilt separately
 * by the node executor (same as the initial run), so this only produces the
 * middle (tool-exchange) messages.
 *
 * The grouping/shape logic is the DB-free {@link reconstructToolExchange} in
 * `rebuild-messages-core.ts`; this module only adds the query.
 */
import { and, asc, eq } from 'drizzle-orm'
import { db, workLogs } from '@crewmeld/db'
import { type RebuiltToolExchange, reconstructToolExchange } from './rebuild-messages-core'
import type { AsyncToolCallMeta } from './tool-loop-types'

export { type RebuiltToolExchange, reconstructToolExchange } from './rebuild-messages-core'

/**
 * Load a node execution's async tool-call rows (by `taskId`) and reconstruct the
 * conversation middle. Only rows flagged `async` are considered — legacy inline
 * tool logs (if any) are ignored.
 */
export async function rebuildNodeToolExchange(taskId: string): Promise<RebuiltToolExchange> {
  const rows = await db
    .select({ metadata: workLogs.metadata })
    .from(workLogs)
    .where(and(eq(workLogs.taskId, taskId), eq(workLogs.logType, 'tool_call')))
    .orderBy(asc(workLogs.createdAt))

  const metas: AsyncToolCallMeta[] = []
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Partial<AsyncToolCallMeta>
    if (meta.async === true && typeof meta.callId === 'string' && typeof meta.round === 'number') {
      metas.push(meta as AsyncToolCallMeta)
    }
  }

  return reconstructToolExchange(metas)
}

/** A journaled tool call flattened for in-memory consumers (approval gate, logs). */
export interface NodeToolResult {
  toolName: string
  toolId: string
  input: Record<string, unknown>
  output: unknown
  round: number
}

/**
 * Load a node's journaled async tool calls (by `taskId`) as a flat result list.
 *
 * In async mode the LLM loop keeps NO in-memory `toolResults` (each call is
 * dispatched and its result lands in work_logs via the callback), so consumers
 * that need "which tools actually ran" — the approval gate's tool-usage check,
 * the node completion log's counts — must read them back from here. Includes
 * failed calls too: a tool that was called and failed still counts as called.
 */
export async function loadNodeToolResults(taskId: string): Promise<NodeToolResult[]> {
  const rows = await db
    .select({ metadata: workLogs.metadata })
    .from(workLogs)
    .where(and(eq(workLogs.taskId, taskId), eq(workLogs.logType, 'tool_call')))
    .orderBy(asc(workLogs.createdAt))

  const results: NodeToolResult[] = []
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Partial<AsyncToolCallMeta> & { output?: unknown }
    if (meta.async === true && typeof meta.callId === 'string') {
      results.push({
        toolName: meta.toolName ?? '',
        toolId: meta.toolId ?? '',
        input: (meta.input ?? {}) as Record<string, unknown>,
        output: meta.output ?? null,
        round: typeof meta.round === 'number' ? meta.round : 0,
      })
    }
  }
  return results
}
