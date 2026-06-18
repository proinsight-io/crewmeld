/**
 * The async-tool state machine, stored entirely in `work_logs` (no extra table).
 *
 * A dispatched async tool call is a `tool_call` row whose `metadata.status` is
 * `pending`; its callback finalizes the SAME row to `completed` / `failed`,
 * writing the processed output. First-Wins atomicity (a conditional jsonb
 * UPDATE) makes duplicate / out-of-order callbacks idempotent. A node's loop
 * resumes only once no `pending` rows remain for its task.
 *
 * Keeping everything in `work_logs` means `buildHistoryFromWorkLogs` (cross-node
 * context) and `rebuildNodeToolExchange` (same-node resume) both read the exact
 * same rows — the journal is the single source of truth.
 */
import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, workLogs } from '@crewmeld/db'
import { t } from '@/lib/core/server-i18n'
import type { FinalizedToolResult } from './finalize-tool-result'
import type { AsyncToolCallMeta } from './tool-loop-types'

export interface WritePendingToolCallParams {
  /** Node execution task this call belongs to (the resume/rebuild key). */
  taskId: string
  employeeId: string
  executionId: string
  nodeId: string
  round: number
  callId: string
  toolName: string
  toolId: string
  instanceName: string
  input: Record<string, unknown>
  /** Sandbox to tear down when the callback lands (pod tools only). */
  sandboxId?: string
  /** Watchdog job id, so the callback can cancel the timeout. */
  watchdogJobId?: string
}

/** Insert the `pending` tool-call row for a freshly dispatched async tool. */
export async function writePendingToolCallLog(p: WritePendingToolCallParams): Promise<void> {
  const meta: AsyncToolCallMeta = {
    async: true,
    status: 'pending',
    callId: p.callId,
    round: p.round,
    toolName: p.toolName,
    toolId: p.toolId,
    instanceName: p.instanceName,
    input: p.input,
    executionId: p.executionId,
    nodeId: p.nodeId,
    ...(p.sandboxId ? { sandboxId: p.sandboxId } : {}),
    ...(p.watchdogJobId ? { watchdogJobId: p.watchdogJobId } : {}),
  }
  await db.insert(workLogs).values({
    id: `log_${nanoid()}`,
    taskId: p.taskId,
    employeeId: p.employeeId,
    logType: 'tool_call',
    content: t('sopToolCallRunning', 'en', { name: p.instanceName || p.toolName }),
    metadata: meta,
  })
}

export interface TerminalApplyResult {
  /** False when no `pending` row matched (duplicate / late / unknown callback). */
  applied: boolean
  /** Owning node task id (present when applied). */
  taskId: string | null
  /** Async tool-call rows still `pending` for that task after this update. */
  remainingPending: number
  /** Sandbox to tear down (pod tools), read back from the row. */
  sandboxId: string | null
  /** Watchdog job to cancel, read back from the row. */
  watchdogJobId: string | null
}

interface TerminalPatch {
  status: 'completed' | 'failed'
  success: boolean
  output: unknown
  resultContent: string
}

/**
 * Atomically flip the matching `pending` row to a terminal state (First-Wins)
 * and report how many async calls remain pending for its task. Safe against
 * duplicate callbacks: the `status = 'pending'` guard means only the first wins.
 */
async function applyTerminal(callId: string, patch: TerminalPatch): Promise<TerminalApplyResult> {
  const i18nKey = patch.success ? 'logWorkSopToolCallSuccess' : 'logWorkSopToolCallFailed'
  // Content is cosmetic here (history rendering reads metadata, not content);
  // the tool/instance name is preserved by the jsonb merge below.
  const content = patch.success ? 'Tool call completed' : 'Tool call failed'

  const mergeJson = JSON.stringify({
    status: patch.status,
    success: patch.success,
    output: patch.output,
    resultContent: patch.resultContent,
    i18nKey,
  })

  const updated = (await db.execute(sql`
    UPDATE work_logs
    SET metadata = metadata || ${mergeJson}::jsonb,
        content = ${content}
    WHERE log_type = 'tool_call'
      AND metadata->>'callId' = ${callId}
      AND metadata->>'status' = 'pending'
    RETURNING task_id, metadata->>'sandboxId' AS sandbox_id, metadata->>'watchdogJobId' AS watchdog_job_id
  `)) as unknown as Array<{
    task_id: string
    sandbox_id: string | null
    watchdog_job_id: string | null
  }>

  if (updated.length === 0) {
    return { applied: false, taskId: null, remainingPending: 0, sandboxId: null, watchdogJobId: null }
  }
  const row = updated[0]

  const counted = (await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM work_logs
    WHERE task_id = ${row.task_id}
      AND log_type = 'tool_call'
      AND metadata->>'status' = 'pending'
  `)) as unknown as Array<{ pending: number }>

  return {
    applied: true,
    taskId: row.task_id,
    remainingPending: counted[0]?.pending ?? 0,
    sandboxId: row.sandbox_id,
    watchdogJobId: row.watchdog_job_id,
  }
}

/** Finalize a successful/failed tool callback onto its pending row. */
export async function completeToolCallLog(
  callId: string,
  finalized: FinalizedToolResult
): Promise<TerminalApplyResult> {
  return applyTerminal(callId, {
    status: finalized.success ? 'completed' : 'failed',
    success: finalized.success,
    output: finalized.output,
    resultContent: finalized.resultContent,
  })
}

/** Fail a pending tool call (watchdog timeout / dispatch error). */
export async function failToolCallLog(callId: string, error: string): Promise<TerminalApplyResult> {
  return applyTerminal(callId, {
    status: 'failed',
    success: false,
    output: { error },
    resultContent: `Tool execution failed: ${error}`,
  })
}
