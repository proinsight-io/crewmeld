import { db } from '@crewmeld/db'
import {
  sopDefinitions,
  sopExecutions,
  sopNodeExecutions,
  sopPauseStates,
  taskExecutions,
  workLogs,
} from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { asc, eq, inArray } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { t } from '@/lib/i18n/server-t'

const logger = createLogger('SopExecutionLogsAPI')

interface TimelineEntry {
  timestamp: string
  type: string
  content: string
  data?: Record<string, unknown>
}

/**
 * Keep only the fields the UI cares about from triggerData. Drops historical duplicates
 * (`value` mirrored `input` verbatim; `file_url` / `project_name` are substrings of
 * `input` and only matter to the SOP runtime, not the timeline view).
 */
function pickTriggerFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const src = raw as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  if (src._meta !== undefined) picked._meta = src._meta
  if (src.input !== undefined) picked.input = src.input
  return picked
}

/**
 * GET /api/employee/tasks/[id]/logs
 *
 * Query SOP execution logs and approval status.
 *
 * Params:
 * - nodeId (optional): specify a node ID to return workLogs for that node only.
 *   If omitted, returns the full execution timeline (SOP start -> node execution -> tool calls -> approvals).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('task:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const locale = resolveLocale(request)
    const { id: executionId } = await params
    const nodeId = request.nextUrl.searchParams.get('nodeId')

    // Query all taskExecutions associated with this SOP execution
    const tasks = await db
      .select({
        id: taskExecutions.id,
        input: taskExecutions.input,
      })
      .from(taskExecutions)
      .where(eq(taskExecutions.sopExecutionId, executionId))

    if (nodeId) {
      // Single-node mode: only return workLogs for tasks matching nodeId
      const matchedTaskIds = tasks
        .filter((t) => {
          const inp = t.input as Record<string, unknown> | null
          return inp?.nodeId === nodeId
        })
        .map((t) => t.id)

      let logs: Array<{
        id: string
        taskId: string
        logType: string
        content: string
        metadata: unknown
        createdAt: Date
      }> = []

      if (matchedTaskIds.length > 0) {
        logs = await db
          .select({
            id: workLogs.id,
            taskId: workLogs.taskId,
            logType: workLogs.logType,
            content: workLogs.content,
            metadata: workLogs.metadata,
            createdAt: workLogs.createdAt,
          })
          .from(workLogs)
          .where(inArray(workLogs.taskId, matchedTaskIds))
          .orderBy(asc(workLogs.createdAt))
      }

      return NextResponse.json({
        success: true,
        data: {
          logs: logs.map((l) => ({
            ...l,
            createdAt: l.createdAt.toISOString(),
          })),
        },
      })
    }

    // -- Full mode: build complete execution timeline --

    // 1. SOP execution info
    const [exec] = await db
      .select({
        id: sopExecutions.id,
        status: sopExecutions.status,
        sopName: sopDefinitions.name,
        sopVersion: sopExecutions.sopVersion,
        triggerData: sopExecutions.triggerData,
        errorMessage: sopExecutions.errorMessage,
        startedAt: sopExecutions.startedAt,
        completedAt: sopExecutions.completedAt,
        createdAt: sopExecutions.createdAt,
      })
      .from(sopExecutions)
      .leftJoin(sopDefinitions, eq(sopExecutions.sopDefinitionId, sopDefinitions.id))
      .where(eq(sopExecutions.id, executionId))
      .limit(1)

    // 2. All node execution records
    const nodeExecs = await db
      .select({
        id: sopNodeExecutions.id,
        nodeId: sopNodeExecutions.nodeId,
        nodeName: sopNodeExecutions.nodeName,
        nodeType: sopNodeExecutions.nodeType,
        status: sopNodeExecutions.status,
        result: sopNodeExecutions.result,
        errorMessage: sopNodeExecutions.errorMessage,
        startedAt: sopNodeExecutions.startedAt,
        completedAt: sopNodeExecutions.completedAt,
        createdAt: sopNodeExecutions.createdAt,
      })
      .from(sopNodeExecutions)
      .where(eq(sopNodeExecutions.executionId, executionId))
      .orderBy(asc(sopNodeExecutions.createdAt))

    // 3. All workLogs
    const taskIds = tasks.map((t) => t.id)
    let allWorkLogs: Array<{
      id: string
      taskId: string
      logType: string
      content: string
      metadata: unknown
      createdAt: Date
    }> = []

    if (taskIds.length > 0) {
      allWorkLogs = await db
        .select({
          id: workLogs.id,
          taskId: workLogs.taskId,
          logType: workLogs.logType,
          content: workLogs.content,
          metadata: workLogs.metadata,
          createdAt: workLogs.createdAt,
        })
        .from(workLogs)
        .where(inArray(workLogs.taskId, taskIds))
        .orderBy(asc(workLogs.createdAt))
    }

    // 4. Approval status
    const approvals = await db
      .select({
        id: sopPauseStates.id,
        nodeId: sopPauseStates.nodeId,
        status: sopPauseStates.status,
        decision: sopPauseStates.decision,
        decidedBy: sopPauseStates.decidedBy,
        comment: sopPauseStates.comment,
        createdAt: sopPauseStates.createdAt,
      })
      .from(sopPauseStates)
      .where(eq(sopPauseStates.executionId, executionId))
      .orderBy(asc(sopPauseStates.createdAt))

    // -- Merge into timeline --
    const timeline: TimelineEntry[] = []

    // SOP started
    if (exec) {
      timeline.push({
        timestamp: (exec.startedAt ?? exec.createdAt).toISOString(),
        type: 'sop_started',
        content: t(
          'api.taskLog.sopStarted',
          {
            name: exec.sopName ?? t('api.taskLog.unknownSop', undefined, locale),
            version: exec.sopVersion,
          },
          locale
        ),
        data: {
          executionId: exec.id,
          triggerData: pickTriggerFields(exec.triggerData),
        },
      })
    }

    // Node execution records
    for (const n of nodeExecs) {
      const nodeTypeLabel: Record<string, string> = {
        digital_employee: t('api.taskLog.nodeTypeDigitalEmployee', undefined, locale),
        human_employee: t('api.taskLog.nodeTypeHumanEmployee', undefined, locale),
        human_confirm: t('api.taskLog.nodeTypeHumanConfirm', undefined, locale),
        switch: t('api.taskLog.nodeTypeSwitch', undefined, locale),
      }
      const typeLabel = nodeTypeLabel[n.nodeType] ?? n.nodeType

      // Node started
      if (n.startedAt) {
        timeline.push({
          timestamp: n.startedAt.toISOString(),
          type: 'node_started',
          content: t('api.taskLog.nodeStarted', { name: n.nodeName, type: typeLabel }, locale),
          data: { nodeId: n.nodeId, nodeName: n.nodeName, nodeType: n.nodeType },
        })
      }

      // Node completed/failed
      if (n.completedAt) {
        const result = n.result as Record<string, unknown> | null
        const entry: TimelineEntry = {
          timestamp: n.completedAt.toISOString(),
          type: n.status === 'error' ? 'node_error' : 'node_completed',
          content:
            n.status === 'error'
              ? t(
                  'api.taskLog.nodeFailed',
                  {
                    name: n.nodeName,
                    error: n.errorMessage ?? t('api.taskLog.unknownError', undefined, locale),
                  },
                  locale
                )
              : t('api.taskLog.nodeCompleted', { name: n.nodeName }, locale),
        }
        // Only the node's natural-language output is exposed. Tool call details already
        // appear as individual worklog_tool_call entries — re-emitting toolResults here
        // would duplicate them. Rounds / totalTokens / switch gateway flags omitted as
        // they are not part of the user-visible node output.
        if (result) {
          entry.data = {
            nodeId: n.nodeId,
            nodeName: n.nodeName,
            summary: result.summary ?? null,
          }
        }
        timeline.push(entry)
      }
    }

    // workLogs (tool call details).
    // - Skip rows whose i18nKey === 'logWorkSopExecCompleted': they 100% duplicate the
    //   summary already surfaced via the node_completed event.
    // - For tool_call rows, narrow metadata to {toolName, input, output, success} —
    //   raw toolId, instanceName fallback, i18n metadata, and the redundant skill_inst-* name
    //   add noise without giving the UI extra signal.
    for (const l of allWorkLogs) {
      const meta = (l.metadata ?? {}) as Record<string, unknown>
      if (meta.i18nKey === 'logWorkSopExecCompleted') continue

      let data: Record<string, unknown>
      if (l.logType === 'tool_call') {
        const display =
          (typeof meta.instanceName === 'string' && meta.instanceName) ||
          (typeof meta.toolName === 'string' && meta.toolName) ||
          'tool'
        data = {
          toolName: display,
          input: meta.input,
          output: meta.output,
          success: meta.success,
        }
      } else {
        data = meta
      }

      timeline.push({
        timestamp: l.createdAt.toISOString(),
        type: `worklog_${l.logType}`,
        content: l.content,
        data,
      })
    }

    // Approval records
    for (const a of approvals) {
      const nodeName = nodeExecs.find((n) => n.nodeId === a.nodeId)?.nodeName ?? a.nodeId
      if (a.decision) {
        timeline.push({
          timestamp: a.createdAt.toISOString(),
          type: 'approval_decided',
          content: t(
            'api.taskLog.approvalDecided',
            {
              name: nodeName,
              decision:
                a.decision === 'approved'
                  ? t('api.taskLog.approvalApproved', undefined, locale)
                  : t('api.taskLog.approvalRejected', undefined, locale),
              comment: a.comment ? ` — ${a.comment}` : '',
            },
            locale
          ),
          data: {
            nodeId: a.nodeId,
            decision: a.decision,
            comment: a.comment,
            decidedBy: a.decidedBy,
          },
        })
      } else {
        timeline.push({
          timestamp: a.createdAt.toISOString(),
          type: 'approval_waiting',
          content: t('api.taskLog.approvalWaiting', { name: nodeName }, locale),
          data: { nodeId: a.nodeId, status: a.status },
        })
      }
    }

    // SOP ended
    if (exec?.completedAt) {
      const entry: TimelineEntry = {
        timestamp: exec.completedAt.toISOString(),
        type: exec.status === 'error' || exec.status === 'failed' ? 'sop_error' : 'sop_completed',
        content:
          exec.status === 'error' || exec.status === 'failed'
            ? t(
                'api.taskLog.sopFailed',
                {
                  error: exec.errorMessage ?? t('api.taskLog.unknownError', undefined, locale),
                },
                locale
              )
            : t('api.taskLog.sopCompleted', { status: exec.status }, locale),
      }
      timeline.push(entry)
    }

    // Sort by time
    timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    logger.info('Query full SOP execution logs', {
      executionId,
      timelineCount: timeline.length,
    })

    return apiOk({
      timeline,
      approvals: approvals.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error('Failed to query SOP execution logs', error)
    return apiErr('api.task.fetchLogsFailed', { status: 500 })
  }
}
