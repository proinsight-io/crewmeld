import { db } from '@crewmeld/db'
import {
  SOP_TERMINAL_STATUSES,
  type SopExecutionStatus,
  sopDefinitions,
  sopExecutions,
  sopNodeExecutions,
  sopPauseStates,
} from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { notifyChannelOnApprovalDecision } from '@/lib/conversation/sop-completion-notifier'
import { t } from '@/lib/core/server-i18n'
import { createExecutionEventWriter, setExecutionMeta } from '@/lib/execution/event-buffer'
import type { SopExecutionEvent } from '@/lib/types/execution-events'
import type { SopNode, SopStateSnapshot } from '@/types/sop'
import { validateBeforeApproval } from './approval-gate'
import { evaluateExits, resolveErrorExit } from './exit-resolver'
import { executeNode, resolveWorkspaceIdFromExecution } from './node-executor'
import { getSopTimeoutQueue } from './queue'

/**
 * Maps (fromStatus → toStatus) to the SSE event type.
 * Returns null if no event should be emitted for this transition.
 */
function getTransitionEventType(
  fromStatus: SopExecutionStatus,
  toStatus: SopExecutionStatus
): SopExecutionEvent['type'] | null {
  if (toStatus === 'running' && fromStatus === 'pending') return 'sop:started'
  if (toStatus === 'running' && fromStatus === 'paused_for_human') return 'sop:resumed'
  if (toStatus === 'running' && fromStatus === 'error') return 'sop:resumed'
  if (toStatus === 'paused_for_human') return 'sop:paused'
  if (toStatus === 'completed') return 'sop:completed'
  if (toStatus === 'error') return 'sop:error'
  if (toStatus === 'timed_out') return 'sop:timed_out'
  if (toStatus === 'cancelled') return 'sop:cancelled'
  if (toStatus === 'failed') return 'sop:error'
  return null
}

const logger = createLogger('SopEngine')

/** Valid state transition map */
export const VALID_TRANSITIONS: Record<SopExecutionStatus, SopExecutionStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['paused_for_human', 'completed', 'error', 'cancelled'],
  paused_for_human: ['running', 'failed', 'timed_out', 'cancelled'],
  error: ['running', 'failed', 'cancelled', 'timed_out'],
  completed: [],
  timed_out: [],
  failed: [],
  cancelled: [],
}

/**
 * State transition function — writes DB + emits SSE event on each transition
 *
 * @returns whether the transition succeeded
 */
export async function transitionStatus(
  executionId: string,
  fromStatus: SopExecutionStatus,
  toStatus: SopExecutionStatus,
  updates?: Record<string, unknown>
): Promise<boolean> {
  if (!VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    logger.warn('Invalid state transition', { executionId, fromStatus, toStatus })
    return false
  }

  const result = await db
    .update(sopExecutions)
    .set({
      status: toStatus,
      updatedAt: new Date(),
      ...(updates as Record<string, unknown>),
    })
    .where(and(eq(sopExecutions.id, executionId), eq(sopExecutions.status, fromStatus)))
    .returning()

  if (result.length === 0) {
    logger.warn('State transition failed (concurrent modification)', {
      executionId,
      fromStatus,
      toStatus,
    })
    return false
  }

  const eventType = getTransitionEventType(fromStatus, toStatus)
  if (eventType) {
    const eventWriter = createExecutionEventWriter(executionId)
    try {
      await eventWriter.write({
        type: eventType,
        timestamp: new Date().toISOString(),
        executionId,
        data: { fromStatus, toStatus },
      })
    } finally {
      await eventWriter.close()
    }
  }

  // Increment total_tasks on task start; update success/failure counts on terminal state
  const shouldUpdateStats =
    (fromStatus === 'pending' && toStatus === 'running') || // task started
    ['completed', 'failed', 'error', 'timed_out', 'cancelled'].includes(toStatus) // task ended
  if (shouldUpdateStats) {
    void updateDailyStats(result[0], toStatus, fromStatus).catch((err) =>
      logger.warn('Failed to update dailyStats', { executionId, error: err })
    )
  }

  return true
}

/**
 * Update daily_stats table (UPSERT) when SOP execution ends
 */
async function updateDailyStats(
  execution: typeof sopExecutions.$inferSelect,
  status: SopExecutionStatus,
  fromStatus: SopExecutionStatus
) {
  // Extract associated employee from triggerData._meta.employeeId
  const meta = (execution.triggerData as Record<string, unknown>)?._meta as
    | Record<string, unknown>
    | undefined
  const employeeId = meta?.employeeId as string | undefined

  // If no associated employee (manually triggered SOP), try looking up from sop_definitions.nodes
  let resolvedEmployeeId = employeeId
  if (!resolvedEmployeeId) {
    try {
      const [def] = await db
        .select({ nodes: sopDefinitions.nodes })
        .from(sopDefinitions)
        .where(eq(sopDefinitions.id, execution.sopDefinitionId as string))
        .limit(1)
      const nodes = def?.nodes as Array<Record<string, unknown>> | undefined
      const empNode = nodes?.find((n) => n.type === 'digital_employee' && n.executorId)
      resolvedEmployeeId = empNode?.executorId as string | undefined
    } catch {
      // ignore
    }
  }

  if (!resolvedEmployeeId) {
    logger.debug('No employeeId found for dailyStats', { executionId: execution.id })
    return
  }

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const isStarting = fromStatus === 'pending' && status === 'running'
  const isSuccess = ['completed', 'running', 'paused_for_human'].includes(status)
  const isFailure = ['failed', 'error', 'timed_out'].includes(status)
  const isHitl = fromStatus === 'paused_for_human'

  const statsId = `ds_${nanoid(16)}`

  if (isStarting) {
    // Task started: only increment total_tasks
    await db.execute(sql`
      INSERT INTO daily_stats (id, employee_id, stat_date, total_tasks, success_count, failure_count, hitl_count, created_at)
      VALUES (${statsId}, ${resolvedEmployeeId}, ${today}, 1, 0, 0, 0, now())
      ON CONFLICT (employee_id, stat_date) DO UPDATE SET
        total_tasks = daily_stats.total_tasks + 1
    `)
  } else {
    // Task ended: update success/failure counts + avg duration (total_tasks already incremented at start)
    const startedAt = execution.startedAt ? new Date(execution.startedAt).getTime() : 0
    const completedAt = execution.completedAt
      ? new Date(execution.completedAt).getTime()
      : Date.now()
    const durationMs = startedAt > 0 ? completedAt - startedAt : 0

    await db.execute(sql`
      INSERT INTO daily_stats (id, employee_id, stat_date, total_tasks, success_count, failure_count, hitl_count, avg_duration_ms, created_at)
      VALUES (${statsId}, ${resolvedEmployeeId}, ${today}, 0,
        ${isSuccess ? 1 : 0}, ${isFailure ? 1 : 0}, ${isHitl ? 1 : 0}, ${durationMs}, now())
      ON CONFLICT (employee_id, stat_date) DO UPDATE SET
        success_count = daily_stats.success_count + ${isSuccess ? 1 : 0},
        failure_count = daily_stats.failure_count + ${isFailure ? 1 : 0},
        hitl_count = daily_stats.hitl_count + ${isHitl ? 1 : 0},
        avg_duration_ms = CASE
          WHEN daily_stats.avg_duration_ms IS NULL THEN ${durationMs}
          ELSE (daily_stats.avg_duration_ms * (daily_stats.success_count + daily_stats.failure_count) + ${durationMs})
               / (daily_stats.success_count + daily_stats.failure_count + 1)
        END
    `)
  }

  logger.info('dailyStats updated', {
    employeeId: resolvedEmployeeId,
    date: today,
    event: isStarting ? 'started' : status,
  })
}

/**
 * Build node map
 */
function buildNodesMap(nodes: SopNode[]): Map<string, SopNode> {
  const map = new Map<string, SopNode>()
  for (const node of nodes) {
    map.set(node.id, node)
  }
  return map
}

/**
 * Check if SOP has exceeded execution time limit
 */
function isSopTimedOut(startedAt: Date | null, timeoutMinutes: number): boolean {
  if (!startedAt || timeoutMinutes <= 0) return false
  const elapsedMs = Date.now() - startedAt.getTime()
  return elapsedMs >= timeoutMinutes * 60 * 1000
}

/**
 * Find the start node (node with no incoming edges)
 */
function findStartNodeId(nodes: SopNode[], edges: Array<{ target: string }>): string | null {
  const targets = new Set(edges.map((e) => e.target))
  for (const node of nodes) {
    if (!targets.has(node.id)) return node.id
  }
  return nodes[0]?.id ?? null
}

/**
 * Persist state snapshot
 */
async function persistSnapshot(executionId: string, snapshot: SopStateSnapshot): Promise<void> {
  await db
    .update(sopExecutions)
    .set({
      stateSnapshot: snapshot as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(sopExecutions.id, executionId))
}

/**
 * Approval pre-validation — intercept before human_employee node execution
 *
 * @returns null means validation passed; string means error exit target node ID; 'terminated' means SOP was terminated
 */
async function runApprovalGate(
  executionId: string,
  definition: { name: string; description: string | null },
  snapshot: SopStateSnapshot,
  nodes: SopNode[],
  nodesMap: Map<string, SopNode>,
  targetNode: SopNode,
  eventWriter: ReturnType<typeof createExecutionEventWriter>
): Promise<string | 'terminated' | null> {
  // Reverse-search execution path for nearest digital employee node, use its executorId for LLM calls
  let executorId: string | undefined
  let workspaceId = ''

  for (let i = snapshot.executionPath.length - 1; i >= 0; i--) {
    const nId = snapshot.executionPath[i]
    const nDef = nodesMap.get(nId)
    if (nDef?.type === 'digital_employee' && nDef.executorId) {
      executorId = nDef.executorId
      break
    }
  }

  if (!executorId) {
    // No preceding digital employee node -> skip validation
    return null
  }

  // Resolve workspaceId
  try {
    workspaceId = await resolveWorkspaceIdFromExecution(executionId)
  } catch {
    // ignore
  }

  const gateResult = await validateBeforeApproval({
    sopName: definition.name,
    sopDescription: definition.description ?? '',
    executionPath: snapshot.executionPath,
    nodeStates: snapshot.nodeStates,
    workflowResults: snapshot.workflowResults,
    allNodes: nodes,
    targetNode,
    executorId,
    workspaceId,
  })

  if (gateResult.valid) {
    return null
  }

  // Validation failed — find the node that should route to error exit
  const faultyNodeId = gateResult.faultyNodeId
  const faultyNode = faultyNodeId ? nodesMap.get(faultyNodeId) : undefined

  if (faultyNodeId && faultyNode) {
    const errorExitResult = resolveErrorExit(faultyNode)
    if (errorExitResult?.targetNodeId) {
      // Mark the node as error, attach validation rejection reason
      snapshot.nodeStates[faultyNodeId] = {
        ...snapshot.nodeStates[faultyNodeId],
        status: 'error',
        completedAt: new Date().toISOString(),
        output: {
          ...snapshot.nodeStates[faultyNodeId]?.output,
          _approvalGateRejection: gateResult.reason,
        },
      }
      await persistSnapshot(executionId, snapshot)

      await eventWriter.write({
        type: 'sop:node:error',
        timestamp: new Date().toISOString(),
        executionId,
        nodeId: faultyNodeId,
        data: {
          error: `Approval pre-validation failed: ${gateResult.reason}`,
          approvalGate: true,
          targetNodeId: errorExitResult.targetNodeId,
        },
      })

      logger.warn('Approval pre-validation failed, routing to error exit', {
        executionId,
        faultyNodeId,
        targetNodeId: errorExitResult.targetNodeId,
        reason: gateResult.reason,
      })

      return errorExitResult.targetNodeId
    }
  }

  // No error exit available -> terminate SOP
  logger.warn('Approval pre-validation failed with no error exit, terminating SOP', {
    executionId,
    faultyNodeId,
    reason: gateResult.reason,
  })

  const reason = gateResult.reason
  await transitionStatus(executionId, 'running', 'error', {
    errorMessage: t('errSopApprovalPreValFailed', 'en', { reason }),
    metadata: { errorI18nKey: 'approvalPreValFailed', errorI18nParams: { reason } },
  })

  await eventWriter.write({
    type: 'sop:error',
    timestamp: new Date().toISOString(),
    executionId,
    data: {
      error: `Approval pre-validation failed: ${gateResult.reason}`,
      approvalGate: true,
      faultyNodeId,
    },
  })

  return 'terminated'
}

/**
 * SOP execution main loop
 *
 * 1. Start from stateSnapshot.currentNodeId
 * 2. Execute current node -> get result
 * 3. Evaluate exits -> get next node ID
 * 4. If next node is null -> SOP endpoint -> completed
 * 5. Otherwise update currentNodeId -> continue loop
 * 6. On human_employee -> pause, wait for callback to resume
 * 7. On human_confirm -> read previous approval result, route directly to step 3 exits
 */
export async function executeSop(executionId: string): Promise<void> {
  const execRows = await db.select().from(sopExecutions).where(eq(sopExecutions.id, executionId))

  const execution = execRows[0]
  if (!execution) {
    logger.error('Execution not found', { executionId })
    return
  }

  const defRows = await db
    .select()
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, execution.sopDefinitionId as string))

  const definition = defRows[0]
  if (!definition) {
    logger.error('SOP definition not found', { sopDefinitionId: execution.sopDefinitionId })
    return
  }

  const nodes = definition.nodes as SopNode[]
  const edges = definition.edges as Array<{ target: string }>
  const nodesMap = buildNodesMap(nodes)

  let snapshot = execution.stateSnapshot as unknown as SopStateSnapshot
  const isFreshStart = !snapshot.currentNodeId

  if (isFreshStart) {
    const startNodeId = findStartNodeId(nodes, edges)
    if (!startNodeId) {
      await transitionStatus(executionId, 'running', 'error', {
        errorMessage: t('sopNoStartNode', 'en'),
        metadata: { errorI18nKey: 'noStartNode' },
      })
      return
    }
    snapshot = {
      currentNodeId: startNodeId,
      nodeStates: {},
      executionPath: [],
      exitDecisions: {},
      variables: {},
      workflowResults: {},
      triggerData: execution.triggerData as Record<string, unknown> | undefined,
    }
  }

  const eventWriter = createExecutionEventWriter(executionId)
  await setExecutionMeta(executionId, { status: 'active' })

  try {
    if (isFreshStart) {
      await eventWriter.write({
        type: 'sop:started',
        timestamp: new Date().toISOString(),
        executionId,
        data: { sopDefinitionId: definition.id },
      })
    }

    let currentNodeId: string | null = snapshot.currentNodeId

    while (currentNodeId) {
      // Check SOP timeout at each loop iteration
      if (isSopTimedOut(execution.startedAt, definition.sopTimeoutMinutes)) {
        const _minutes = String(definition.sopTimeoutMinutes)
        await transitionStatus(executionId, 'running', 'timed_out', {
          errorMessage: t('errSopTaskTimeout', 'en', { minutes: _minutes }),
          completedAt: new Date(),
          metadata: { errorI18nKey: 'taskTimeout', errorI18nParams: { minutes: _minutes } },
        })

        await eventWriter.write({
          type: 'sop:timed_out',
          timestamp: new Date().toISOString(),
          executionId,
          data: { nodeId: currentNodeId, reason: 'timeout' },
        })

        await setExecutionMeta(executionId, { status: 'timed_out' })
        return
      }

      const node = nodesMap.get(currentNodeId)
      if (!node) {
        await transitionStatus(executionId, 'running', 'error', {
          errorMessage: t('errSopNodeNotFound', 'en', { nodeId: currentNodeId }),
          metadata: { errorI18nKey: 'nodeNotFound', errorI18nParams: { nodeId: currentNodeId } },
        })
        return
      }

      snapshot.currentNodeId = currentNodeId

      // ── Approval pre-validation (Approval Gate) ──
      // Validate preceding content before executing human_employee node
      if (node.type === 'human_employee') {
        const gateResult = await runApprovalGate(
          executionId,
          definition,
          snapshot,
          nodes,
          nodesMap,
          node,
          eventWriter
        )
        if (gateResult === 'terminated') {
          return
        }
        if (gateResult !== null) {
          // Validation failed, route to error exit target node
          currentNodeId = gateResult
          continue
        }
        // gateResult === null -> validation passed, continue normal execution
      }

      // Only initialize state on first node entry, preserve retryCount on retry
      const existingState = snapshot.nodeStates[currentNodeId]
      if (!existingState || existingState.status !== 'error') {
        snapshot.nodeStates[currentNodeId] = {
          status: 'running',
          startedAt: new Date().toISOString(),
          retryCount: 0,
        }
      } else {
        // Retry: preserve retryCount, only update status
        snapshot.nodeStates[currentNodeId] = {
          ...existingState,
          status: 'running',
        }
      }
      await persistSnapshot(executionId, snapshot)

      await eventWriter.write({
        type: 'sop:node:started',
        timestamp: new Date().toISOString(),
        executionId,
        nodeId: currentNodeId,
        data: { nodeName: node.name, nodeType: node.type },
      })

      const result = await executeNode(executionId, node, snapshot, nodes)

      if (result.paused) {
        await transitionStatus(executionId, 'running', 'paused_for_human')
        await persistSnapshot(executionId, snapshot)
        return
      }

      if (result.error) {
        logger.info('Engine received node error', {
          executionId,
          nodeId: currentNodeId,
          error: result.error,
          errorExit: result.errorExit,
          paused: result.paused,
        })
        // Timeout check: if SOP exceeded time limit, mark as timed_out directly, no retry
        if (isSopTimedOut(execution.startedAt, definition.sopTimeoutMinutes)) {
          const _minutes = String(definition.sopTimeoutMinutes)
          await transitionStatus(executionId, 'running', 'timed_out', {
            errorMessage: t('errSopTaskTimeoutNoRetry', 'en', { minutes: _minutes }),
            completedAt: new Date(),
            metadata: {
              errorI18nKey: 'taskTimeoutNoRetry',
              errorI18nParams: { minutes: _minutes },
            },
          })

          await eventWriter.write({
            type: 'sop:timed_out',
            timestamp: new Date().toISOString(),
            executionId,
            data: { error: result.error, nodeId: currentNodeId, reason: 'timeout' },
          })

          await setExecutionMeta(executionId, { status: 'timed_out' })
          return
        }

        // Business error (LLM marked [ERROR]) — no retry, go to error exit directly
        // System error (network timeout etc.) — allow retry
        if (!result.errorExit) {
          const maxRetries = definition.maxRetries ?? 3
          const currentRetry = snapshot.nodeStates[currentNodeId]?.retryCount ?? 0

          if (currentRetry < maxRetries) {
            snapshot.nodeStates[currentNodeId] = {
              ...snapshot.nodeStates[currentNodeId],
              retryCount: currentRetry + 1,
              status: 'error',
            }
            await persistSnapshot(executionId, snapshot)

            await eventWriter.write({
              type: 'sop:node:error',
              timestamp: new Date().toISOString(),
              executionId,
              nodeId: currentNodeId,
              data: { error: result.error, retryCount: currentRetry + 1 },
            })

            continue
          }
        }

        // Business error reaches here directly / system error retries exhausted -> check error exit
        const errorExitResult = resolveErrorExit(node)
        if (errorExitResult) {
          // Has error exit and connected -> mark node as error, route via error exit
          snapshot.nodeStates[currentNodeId] = {
            ...snapshot.nodeStates[currentNodeId],
            status: 'error',
            completedAt: new Date().toISOString(),
            output: { error: result.error },
            exitId: errorExitResult.exitId,
          }
          snapshot.executionPath.push(currentNodeId)
          await persistSnapshot(executionId, snapshot)

          await eventWriter.write({
            type: 'sop:node:error',
            timestamp: new Date().toISOString(),
            executionId,
            nodeId: currentNodeId,
            data: {
              error: result.error,
              errorExit: true,
              targetNodeId: errorExitResult.targetNodeId,
            },
          })

          currentNodeId = errorExitResult.targetNodeId
          continue
        }

        // No error exit -> terminate SOP
        logger.warn('Node error with no error exit, terminating SOP', {
          executionId,
          nodeId: currentNodeId,
          error: result.error,
          errorExit: result.errorExit,
        })
        await transitionStatus(executionId, 'running', 'error', {
          errorMessage: result.error,
        })

        await eventWriter.write({
          type: 'sop:error',
          timestamp: new Date().toISOString(),
          executionId,
          data: { error: result.error, nodeId: currentNodeId },
        })
        return
      }

      snapshot.nodeStates[currentNodeId] = {
        ...snapshot.nodeStates[currentNodeId],
        status: 'completed',
        completedAt: new Date().toISOString(),
        output: result.output,
      }
      snapshot.executionPath.push(currentNodeId)

      await eventWriter.write({
        type: 'sop:node:completed',
        timestamp: new Date().toISOString(),
        executionId,
        nodeId: currentNodeId,
        data: { output: result.output },
      })

      const exitResult = evaluateExits(node, result)

      if (exitResult) {
        snapshot.nodeStates[currentNodeId] = {
          ...snapshot.nodeStates[currentNodeId],
          exitId: exitResult.exitId,
        }
      }

      await persistSnapshot(executionId, snapshot)

      // Treat any falsy targetNodeId (null / undefined / '') as "SOP endpoint"
      // — hand-built or UI-built SOPs whose terminal exit just omits the
      // field end up as `undefined`, not `null`, so a strict `=== null`
      // check leaves the SOP stuck in `running` forever.
      if (!exitResult || !exitResult.targetNodeId) {
        await transitionStatus(executionId, 'running', 'completed', {
          completedAt: new Date(),
        })

        await eventWriter.write({
          type: 'sop:completed',
          timestamp: new Date().toISOString(),
          executionId,
          data: { executionPath: snapshot.executionPath },
        })

        await setExecutionMeta(executionId, { status: 'complete' })
        return
      }

      currentNodeId = exitResult.targetNodeId
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('SOP execution failed', { executionId, error: errorMessage })

    await transitionStatus(executionId, 'running', 'error', {
      errorMessage,
    })

    await setExecutionMeta(executionId, { status: 'error' })
  } finally {
    await eventWriter.close()
  }
}

/**
 * Resume SOP execution after approval
 */
export async function resumeSopFromPause(pauseState: {
  executionId: string
  nodeId: string
  decision: string
  decidedBy: string
  comment?: string | null
}): Promise<void> {
  const execRows = await db
    .select()
    .from(sopExecutions)
    .where(eq(sopExecutions.id, pauseState.executionId))

  const execution = execRows[0]
  if (!execution) {
    logger.error('Execution not found for resume', { executionId: pauseState.executionId })
    return
  }

  const snapshot = execution.stateSnapshot as unknown as SopStateSnapshot

  snapshot.exitDecisions[pauseState.nodeId] = {
    decision: pauseState.decision as 'approved' | 'rejected',
    decidedBy: pauseState.decidedBy,
    decidedAt: new Date().toISOString(),
    comment: pauseState.comment ?? undefined,
  }

  snapshot.nodeStates[pauseState.nodeId] = {
    ...snapshot.nodeStates[pauseState.nodeId],
    status: 'completed',
    completedAt: new Date().toISOString(),
    output: { decision: pauseState.decision, comment: pauseState.comment },
  }
  // Supplement executionPath — human_employee node exited main loop early due to pause,
  // did not reach executionPath.push, causing subsequent human_confirm's
  // findPreviousHumanDecision to not find the approval decision.
  if (!snapshot.executionPath.includes(pauseState.nodeId)) {
    snapshot.executionPath.push(pauseState.nodeId)
  }
  // Sync update sopNodeExecutions table (keep consistent with stateSnapshot)
  await db
    .update(sopNodeExecutions)
    .set({
      status: 'completed',
      result: { decision: pauseState.decision, comment: pauseState.comment },
      completedAt: new Date(),
    })
    .where(
      and(
        eq(sopNodeExecutions.executionId, pauseState.executionId),
        eq(sopNodeExecutions.nodeId, pauseState.nodeId)
      )
    )

  if (pauseState.decision === 'rejected') {
    const defRows = await db
      .select()
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, execution.sopDefinitionId as string))
    const definition = defRows[0]
    const maxRejections = definition?.maxRejectionCycles ?? 3

    if (execution.rejectionCount + 1 >= maxRejections) {
      const _max = String(maxRejections)
      await transitionStatus(pauseState.executionId, 'paused_for_human', 'failed', {
        errorMessage: t('errSopRejectionLimit', 'en', { max: _max }),
        rejectionCount: execution.rejectionCount + 1,
        metadata: { errorI18nKey: 'rejectionLimit', errorI18nParams: { max: _max } },
      })
      return
    }

    await db
      .update(sopExecutions)
      .set({ rejectionCount: execution.rejectionCount + 1 })
      .where(eq(sopExecutions.id, pauseState.executionId))
  }

  const transitioned = await transitionStatus(pauseState.executionId, 'paused_for_human', 'running')

  if (!transitioned) return

  // Approval decision notification: notify user for both approve and reject
  const meta = (execution.triggerData as Record<string, unknown>)?._meta as
    | { conversationId?: string; employeeId?: string }
    | undefined
  if (meta?.conversationId) {
    const [defRow] = await db
      .select({ name: sopDefinitions.name })
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, execution.sopDefinitionId as string))
    const prevNodeId = snapshot.executionPath[snapshot.executionPath.length - 1]
    const prevState = prevNodeId ? snapshot.nodeStates[prevNodeId] : undefined
    const prevWfResult = prevNodeId ? snapshot.workflowResults[prevNodeId] : undefined
    const prevOutput = prevWfResult?.output ?? prevState?.output
    let previousNodeName: string | undefined
    if (prevNodeId) {
      const [nodeRow] = await db
        .select({ nodeName: sopNodeExecutions.nodeName })
        .from(sopNodeExecutions)
        .where(eq(sopNodeExecutions.nodeId, prevNodeId))
        .limit(1)
      previousNodeName = nodeRow?.nodeName ?? undefined
    }

    void notifyChannelOnApprovalDecision({
      conversationId: meta.conversationId,
      sopName: defRow?.name ?? 'SOP',
      executionId: pauseState.executionId,
      decision: pauseState.decision as 'approved' | 'rejected',
      decidedBy: pauseState.decidedBy,
      comment: pauseState.comment ?? undefined,
      previousNodeName,
      previousNodeResult: prevOutput ? JSON.stringify(prevOutput, null, 2) : undefined,
    })
  }

  await persistSnapshot(pauseState.executionId, snapshot)

  const defRows = await db
    .select()
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, execution.sopDefinitionId as string))
  const definition = defRows[0]
  if (!definition) return

  const nodes = definition.nodes as SopNode[]
  const nodesMap = buildNodesMap(nodes)
  const currentNode = nodesMap.get(pauseState.nodeId)
  if (!currentNode) return

  const exitResult = evaluateExits(currentNode, {
    output: { decision: pauseState.decision, comment: pauseState.comment },
  })

  if (!exitResult || exitResult.targetNodeId === null) {
    await transitionStatus(pauseState.executionId, 'running', 'completed', {
      completedAt: new Date(),
    })

    // No subsequent nodes: SOP completed, notify user of final result
    if (meta?.conversationId && execution.sopDefinitionId) {
      void notifySopResult(pauseState.executionId, execution.sopDefinitionId, meta.conversationId)
    }
    return
  }

  snapshot.currentNodeId = exitResult.targetNodeId
  await persistSnapshot(pauseState.executionId, snapshot)

  // Resume execution, notify original conversation user upon completion
  void executeSop(pauseState.executionId).then(async () => {
    if (!meta?.conversationId || !execution.sopDefinitionId) return
    await notifySopResult(pauseState.executionId, execution.sopDefinitionId, meta.conversationId)
  })
}

/**
 * Query SOP final execution result and push to original conversation user
 */
async function notifySopResult(
  executionId: string,
  sopDefinitionId: string,
  conversationId: string
): Promise<void> {
  try {
    const [finalExec] = await db
      .select({
        status: sopExecutions.status,
        stateSnapshot: sopExecutions.stateSnapshot,
        errorMessage: sopExecutions.errorMessage,
      })
      .from(sopExecutions)
      .where(eq(sopExecutions.id, executionId))
      .limit(1)

    if (!finalExec) return

    const terminalStatuses = ['completed', 'failed', 'timed_out', 'cancelled', 'error']
    if (!terminalStatuses.includes(finalExec.status)) return

    const finalSnapshot = finalExec.stateSnapshot as unknown as SopStateSnapshot
    const meta = (finalSnapshot.triggerData as Record<string, unknown>)?._meta as
      | Record<string, unknown>
      | undefined
    const isZh = (meta?.userLanguage as string) !== 'en'

    // Query approval results (if any)
    const approvalResults = await db
      .select({
        decision: sopPauseStates.decision,
        decidedBy: sopPauseStates.decidedBy,
        comment: sopPauseStates.comment,
      })
      .from(sopPauseStates)
      .where(and(eq(sopPauseStates.executionId, executionId), eq(sopPauseStates.status, 'decided')))

    const outputParts: string[] = []

    // Include approval results
    if (approvalResults.length > 0) {
      for (const ar of approvalResults) {
        const decisionText =
          ar.decision === 'approved'
            ? t('approvalApproved', isZh ? 'zh' : 'en')
            : t('approvalRejected', isZh ? 'zh' : 'en')
        const commentText = ar.comment
          ? `\n${t('approvalComment', isZh ? 'zh' : 'en')}${isZh ? '：' : ': '}${ar.comment}`
          : ''
        outputParts.push(decisionText + commentText)
      }
    }

    for (const nodeId of finalSnapshot.executionPath ?? []) {
      const ns = finalSnapshot.nodeStates[nodeId]
      const wfr = finalSnapshot.workflowResults[nodeId]
      const out = wfr?.output ?? ns?.output
      if (out && Object.keys(out).length > 0) {
        for (const key of ['result', 'output', 'content', 'text', 'sql', 'summary', 'response']) {
          if (out[key] && typeof out[key] === 'string') {
            outputParts.push(out[key] as string)
            break
          }
        }
        if (outputParts.length === 0) {
          try {
            outputParts.push(JSON.stringify(out, null, 2))
          } catch {
            /* skip */
          }
        }
      }
    }

    const { notifyChannelOnSopCompletion } = await import(
      '@/lib/conversation/sop-completion-notifier'
    )
    const [defRow] = await db
      .select({ name: sopDefinitions.name })
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, sopDefinitionId))

    await notifyChannelOnSopCompletion({
      conversationId,
      sopName: defRow?.name ?? 'SOP',
      executionId,
      output: outputParts.length > 0 ? [...new Set(outputParts)].join('\n') : undefined,
      errorMessage: finalExec.errorMessage ?? undefined,
      status: finalExec.status as 'completed' | 'failed' | 'error',
    })
  } catch (err) {
    logger.error('SOP completion result push failed', { executionId, error: err })
  }
}

/**
 * Cancel SOP execution
 */
export async function cancelSopExecution(executionId: string): Promise<boolean> {
  const execRows = await db.select().from(sopExecutions).where(eq(sopExecutions.id, executionId))

  const execution = execRows[0]
  if (!execution) return false

  if (SOP_TERMINAL_STATUSES.includes(execution.status)) {
    return false
  }

  const transitioned = await transitionStatus(executionId, execution.status, 'cancelled', {
    completedAt: new Date(),
  })

  if (!transitioned) return false

  const pauseRows = await db
    .select()
    .from(sopPauseStates)
    .where(and(eq(sopPauseStates.executionId, executionId), eq(sopPauseStates.status, 'waiting')))

  const timeoutQueue = getSopTimeoutQueue()
  for (const pause of pauseRows) {
    if (pause.timeoutJobId && timeoutQueue) {
      try {
        const job = await timeoutQueue.getJob(pause.timeoutJobId)
        if (job) await job.remove()
      } catch {
        logger.warn('Failed to remove timeout job', { jobId: pause.timeoutJobId })
      }
    }
  }

  await setExecutionMeta(executionId, { status: 'cancelled' })

  return true
}

/**
 * Cold recovery — query unfinished SOP instances on process start and resume execution
 */
export async function recoverSopInstances(): Promise<void> {
  // Skip cold recovery in development — frequent restarts would repeatedly trigger old SOPs
  if (process.env.NODE_ENV === 'development' && process.env.SOP_COLD_RECOVERY !== '1') {
    logger.info('SOP cold recovery skipped in development (set SOP_COLD_RECOVERY=1 to enable)')
    return
  }

  // Distributed lock: prevent multiple replicas from running cold recovery simultaneously
  const { acquireLock, releaseLock } = await import('@/lib/core/config/redis')
  const lockValue = `recover-${Date.now()}`
  const acquired = await acquireLock('sop:cold-recovery-lock', lockValue, 120)
  if (!acquired) {
    logger.info('SOP cold recovery skipped: another instance is running')
    return
  }

  try {
    await doRecoverSopInstances()
  } finally {
    await releaseLock('sop:cold-recovery-lock', lockValue)
  }
}

async function doRecoverSopInstances(): Promise<void> {
  const SOP_STALE_THRESHOLD_MS = 30 * 60 * 1000
  const staleThreshold = new Date(Date.now() - SOP_STALE_THRESHOLD_MS)

  const activeInstances = await db
    .select()
    .from(sopExecutions)
    .where(
      and(
        inArray(sopExecutions.status, ['running', 'paused_for_human', 'error']),
        lt(sopExecutions.updatedAt, staleThreshold)
      )
    )

  if (activeInstances.length === 0) {
    logger.info('No stale SOP instances to recover')
    return
  }

  logger.info('Recovering stale SOP instances', { count: activeInstances.length })

  for (const instance of activeInstances) {
    try {
      switch (instance.status) {
        case 'paused_for_human': {
          const pauseRows = await db
            .select()
            .from(sopPauseStates)
            .where(
              and(eq(sopPauseStates.executionId, instance.id), eq(sopPauseStates.status, 'waiting'))
            )

          const pauseState = pauseRows[0]

          if (!pauseState) {
            // No waiting pause record, but execution is still paused_for_human
            // Approval was decided but resume was not triggered, find decided pause to resume
            const decidedRows = await db
              .select()
              .from(sopPauseStates)
              .where(
                and(
                  eq(sopPauseStates.executionId, instance.id),
                  eq(sopPauseStates.status, 'decided')
                )
              )

            const decidedPause = decidedRows[0]
            if (decidedPause) {
              logger.info('Recovering stuck paused_for_human SOP (pause already decided)', {
                executionId: instance.id,
                pauseId: decidedPause.id,
                decision: decidedPause.decision,
              })
              void resumeSopFromPause({
                executionId: instance.id,
                nodeId: decidedPause.nodeId,
                decision: decidedPause.decision ?? 'approved',
                decidedBy: decidedPause.decidedBy ?? 'system',
                comment: decidedPause.comment,
              })
            } else {
              // Neither waiting nor decided, data anomaly, mark as failed
              logger.warn('paused_for_human SOP has no pause records, marking failed', {
                executionId: instance.id,
              })
              await transitionStatus(instance.id, 'paused_for_human', 'failed', {
                errorMessage: t('approvalRecordLost', 'en'),
                completedAt: new Date(),
                metadata: { errorI18nKey: 'approvalRecordLost' },
              })
            }
            break
          }

          if (pauseState.expiresAt) {
            const remaining = pauseState.expiresAt.getTime() - Date.now()
            const timeoutQueue = getSopTimeoutQueue()
            if (remaining > 0 && timeoutQueue) {
              await timeoutQueue.add(
                'sop-node-timeout',
                {
                  executionId: instance.id,
                  nodeId: pauseState.nodeId,
                  pauseId: pauseState.id,
                  type: 'node',
                },
                { delay: remaining }
              )
              logger.info('Re-registered timeout job', {
                executionId: instance.id,
                remainingMs: remaining,
              })
            } else if (remaining <= 0) {
              const { processTimeout } = await import('./workers/timeout-worker')
              await processTimeout({
                executionId: instance.id,
                nodeId: pauseState.nodeId,
                pauseId: pauseState.id,
                type: 'node',
              })
            }
          }
          break
        }

        case 'running': {
          logger.info('Resuming running SOP', { executionId: instance.id })
          void executeSop(instance.id)
          break
        }

        case 'error': {
          const defRows = await db
            .select()
            .from(sopDefinitions)
            .where(eq(sopDefinitions.id, instance.sopDefinitionId as string))
          const definition = defRows[0]

          // Timeout check: takes priority over retry decision
          if (isSopTimedOut(instance.startedAt, definition?.sopTimeoutMinutes ?? 1440)) {
            logger.info('SOP timed out during cold recovery', { executionId: instance.id })
            const _coldMinutes = String(definition?.sopTimeoutMinutes ?? 1440)
            await transitionStatus(instance.id, 'error', 'timed_out', {
              errorMessage: t('errSopTaskTimeoutNoRetry', 'en', { minutes: _coldMinutes }),
              completedAt: new Date(),
              metadata: {
                errorI18nKey: 'taskTimeoutNoRetry',
                errorI18nParams: { minutes: _coldMinutes },
              },
            })
            break
          }

          const maxRetries = definition?.maxRetries ?? 3

          if (instance.retryCount < maxRetries) {
            logger.info('Retrying errored SOP', {
              executionId: instance.id,
              retryCount: instance.retryCount,
            })
            void executeSop(instance.id)
          } else {
            await transitionStatus(instance.id, 'error', 'failed', {
              errorMessage: t('errSopMaxRetriesExceeded', 'en'),
              metadata: { errorI18nKey: 'maxRetriesExceeded' },
            })
          }
          break
        }
      }
    } catch (error) {
      logger.error('Failed to recover SOP instance', {
        executionId: instance.id,
        error: (error as Error).message,
      })
    }
  }
}
