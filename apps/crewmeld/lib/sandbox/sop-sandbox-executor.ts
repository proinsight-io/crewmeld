/**
 * SOP sandbox dry-run executor.
 *
 * Reuses the real SOP engine — sandbox records only mirror state.
 * The external-call policy is passed via `triggerData._sandboxPolicy`
 * so node executors can decide whether to intercept LLM / email / push
 * side effects (see `lib/sop/node-executor.ts:25`).
 */

import { db } from '@crewmeld/db'
import { sandboxRuns, sopDefinitions, sopExecutions, sopNodeExecutions } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { generateExecutionId } from '@/lib/core/execution-id'
import { t } from '@/lib/core/server-i18n'
import { executeSop, transitionStatus } from '@/lib/sop/engine'
import { getSopTimeoutQueue } from '@/lib/sop/queue'
import type { ExternalCallPolicy } from '@/types/sandbox'

const logger = createLogger('SopSandboxExecutor')

const POLL_INTERVAL_MS = 2000
const MAX_POLL_DURATION_MS = 15 * 60 * 1000

interface SopSandboxParams {
  runId: string
  sopDefinitionId: string
  triggerData: Record<string, unknown>
  policy: ExternalCallPolicy
  userId: string
}

/**
 * Sandbox dry-run entry point — creates a real `sopExecutions` row
 * (with `_sandboxPolicy` injected into triggerData) and delegates to
 * the SOP engine. Status is mirrored back to `sandbox_runs` via polling.
 */
export async function executeSopSandbox(params: SopSandboxParams): Promise<void> {
  const { runId, sopDefinitionId, triggerData, policy, userId } = params

  const [sopDef] = await db
    .select()
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, sopDefinitionId))
    .limit(1)

  if (!sopDef) {
    await db
      .update(sandboxRuns)
      .set({
        status: 'failed',
        errorMessage: t('sandboxSopNotFound', 'en'),
        updatedAt: new Date(),
      })
      .where(eq(sandboxRuns.id, runId))
    return
  }

  if (!sopDef.isActive) {
    await db
      .update(sandboxRuns)
      .set({
        status: 'failed',
        errorMessage: t('sandboxSopDisabled', 'en'),
        updatedAt: new Date(),
      })
      .where(eq(sandboxRuns.id, runId))
    return
  }

  const executionId = generateExecutionId('sopsbx')

  await db.insert(sopExecutions).values({
    id: executionId,
    sopDefinitionId,
    sopVersion: sopDef.version,
    triggeredBy: userId,
    status: 'pending',
    stateSnapshot: {},
    triggerData: {
      ...triggerData,
      _sandboxPolicy: policy,
      _sandboxRunId: runId,
    },
  })

  const timeoutQueue = getSopTimeoutQueue()
  if (timeoutQueue && sopDef.sopTimeoutMinutes > 0) {
    await timeoutQueue.add(
      'sop-timeout',
      {
        executionId,
        type: 'sop',
      },
      { delay: sopDef.sopTimeoutMinutes * 60 * 1000 }
    )
  }

  const transitioned = await transitionStatus(executionId, 'pending', 'running', {
    startedAt: new Date(),
  })

  if (!transitioned) {
    await db
      .update(sandboxRuns)
      .set({
        status: 'failed',
        errorMessage: t('sandboxSopStartFailed', 'en'),
        updatedAt: new Date(),
      })
      .where(eq(sandboxRuns.id, runId))
    return
  }

  await db
    .update(sandboxRuns)
    .set({
      status: 'running',
      startedAt: new Date(),
      executionPath: [executionId],
      updatedAt: new Date(),
    })
    .where(eq(sandboxRuns.id, runId))

  logger.info('SOP sandbox delegating to real engine', { runId, executionId, sopDefinitionId })

  void executeSop(executionId)
  void pollAndSyncStatus(runId, executionId)
}

const TERMINAL_SOP_STATUSES = ['completed', 'timed_out', 'error', 'failed', 'cancelled']
const SOP_TO_SANDBOX_STATUS: Record<string, string> = {
  pending: 'pending',
  running: 'running',
  paused_for_human: 'waiting_for_input',
  completed: 'completed',
  timed_out: 'timeout',
  error: 'failed',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * Poll `sopExecutions.status` and mirror it onto `sandbox_runs`.
 * On terminal status, also collect node execution results into `nodeResults` JSONB.
 */
async function pollAndSyncStatus(runId: string, executionId: string): Promise<void> {
  const startMs = Date.now()
  let lastSyncedStatus = ''

  while (Date.now() - startMs < MAX_POLL_DURATION_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    try {
      const [exec] = await db
        .select({
          status: sopExecutions.status,
          errorMessage: sopExecutions.errorMessage,
          startedAt: sopExecutions.startedAt,
          completedAt: sopExecutions.completedAt,
        })
        .from(sopExecutions)
        .where(eq(sopExecutions.id, executionId))
        .limit(1)

      if (!exec) break

      const sandboxStatus = SOP_TO_SANDBOX_STATUS[exec.status] ?? exec.status

      if (sandboxStatus !== lastSyncedStatus) {
        lastSyncedStatus = sandboxStatus

        const updatePayload: Record<string, unknown> = {
          status: sandboxStatus,
          updatedAt: new Date(),
        }

        if (exec.errorMessage) {
          updatePayload.errorMessage = exec.errorMessage
        }

        if (TERMINAL_SOP_STATUSES.includes(exec.status)) {
          if (exec.completedAt) {
            updatePayload.completedAt = exec.completedAt
          }
          if (exec.startedAt) {
            const end = exec.completedAt ?? new Date()
            updatePayload.totalDurationMs = end.getTime() - exec.startedAt.getTime()
          }

          const nodeExecs = await db
            .select({
              nodeId: sopNodeExecutions.nodeId,
              nodeName: sopNodeExecutions.nodeName,
              nodeType: sopNodeExecutions.nodeType,
              status: sopNodeExecutions.status,
              errorMessage: sopNodeExecutions.errorMessage,
              startedAt: sopNodeExecutions.startedAt,
              completedAt: sopNodeExecutions.completedAt,
            })
            .from(sopNodeExecutions)
            .where(eq(sopNodeExecutions.executionId, executionId))

          updatePayload.nodeResults = nodeExecs.map((n) => ({
            nodeId: n.nodeId,
            nodeName: n.nodeName,
            blockType: n.nodeType,
            status: n.status === 'completed' ? 'success' : n.status,
            durationMs:
              n.startedAt && n.completedAt
                ? new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()
                : 0,
            error: n.errorMessage ?? undefined,
            intercepted: false,
            simulated: false,
          }))
        }

        await db.update(sandboxRuns).set(updatePayload).where(eq(sandboxRuns.id, runId))
      }

      if (TERMINAL_SOP_STATUSES.includes(exec.status)) {
        logger.info('SOP sandbox sync complete', { runId, executionId, finalStatus: exec.status })
        return
      }
    } catch (err) {
      logger.warn('SOP sandbox poll error', { runId, error: (err as Error).message })
    }
  }

  logger.warn('SOP sandbox poll timed out', { runId, executionId })
  await db
    .update(sandboxRuns)
    .set({
      status: 'timeout',
      errorMessage: t('sandboxStateSyncTimeout', 'en'),
      updatedAt: new Date(),
    })
    .where(eq(sandboxRuns.id, runId))
}
