import { db } from '@crewmeld/db'
import type { SopExecutionStatus } from '@crewmeld/db/schema'
import { sopDefinitions, sopExecutions, sopNodeExecutions, user } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, count, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

const logger = createLogger('SopExecutionListAPI')

const VALID_STATUSES: SopExecutionStatus[] = [
  'pending',
  'running',
  'paused_for_human',
  'paused_for_tool',
  'completed',
  'timed_out',
  'error',
  'failed',
  'cancelled',
]

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('task:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { searchParams } = new URL(request.url)

    const statusParam = searchParams.get('status')
    const sopId = searchParams.get('sop_id')
    const dateFrom = searchParams.get('date_from')
    const dateTo = searchParams.get('date_to')
    const page = Math.max(1, Number(searchParams.get('page') ?? '1'))
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(searchParams.get('page_size') ?? String(DEFAULT_PAGE_SIZE)))
    )

    const conditions: SQL[] = []

    if (statusParam) {
      const statuses = statusParam.split(',').map((s) => s.trim())
      for (const s of statuses) {
        if (!VALID_STATUSES.includes(s as SopExecutionStatus)) {
          return apiErr('api.task.statusInvalid', { status: 400, params: { status: s } })
        }
      }
      conditions.push(inArray(sopExecutions.status, statuses as SopExecutionStatus[]))
    }

    if (sopId) {
      conditions.push(eq(sopExecutions.sopDefinitionId, sopId))
    }

    if (dateFrom) {
      conditions.push(gte(sopExecutions.createdAt, new Date(dateFrom)))
    }

    if (dateTo) {
      conditions.push(lte(sopExecutions.createdAt, new Date(dateTo)))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [totalResult, rows] = await Promise.all([
      db.select({ value: count() }).from(sopExecutions).where(whereClause),
      db
        .select({
          id: sopExecutions.id,
          sopDefinitionId: sopExecutions.sopDefinitionId,
          sopName: sopDefinitions.name,
          sopVersion: sopExecutions.sopVersion,
          sopNodes: sopDefinitions.nodes,
          status: sopExecutions.status,
          triggeredBy: sopExecutions.triggeredBy,
          triggeredByName: user.name,
          triggerData: sopExecutions.triggerData,
          stateSnapshot: sopExecutions.stateSnapshot,
          errorMessage: sopExecutions.errorMessage,
          retryCount: sopExecutions.retryCount,
          startedAt: sopExecutions.startedAt,
          completedAt: sopExecutions.completedAt,
          createdAt: sopExecutions.createdAt,
        })
        .from(sopExecutions)
        .leftJoin(sopDefinitions, eq(sopExecutions.sopDefinitionId, sopDefinitions.id))
        .leftJoin(user, eq(sopExecutions.triggeredBy, user.id))
        .where(whereClause)
        .orderBy(desc(sopExecutions.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ])

    // Batch fetch node execution counts for all executions in this page
    const executionIds = rows.map((r) => r.id)
    const nodeCountsMap: Record<string, { completed: number; total: number }> = {}

    if (executionIds.length > 0) {
      const nodeCounts = await db
        .select({
          executionId: sopNodeExecutions.executionId,
          total: count(),
          completed: sql<number>`count(*) filter (where ${sopNodeExecutions.status} = 'completed')`,
        })
        .from(sopNodeExecutions)
        .where(inArray(sopNodeExecutions.executionId, executionIds))
        .groupBy(sopNodeExecutions.executionId)

      for (const nc of nodeCounts) {
        nodeCountsMap[nc.executionId] = {
          completed: Number(nc.completed),
          total: Number(nc.total),
        }
      }
    }

    const total = totalResult[0]?.value ?? 0
    const totalPages = Math.ceil(total / pageSize)

    const data = rows.map((row) => {
      const snapshot = (row.stateSnapshot ?? {}) as Record<string, unknown>
      // Resolve currentNodeName from snapshot.currentNodeId + SOP definition nodes
      let currentNodeName: string | null = null
      const currentNodeId = snapshot.currentNodeId as string | undefined
      if (currentNodeId && Array.isArray(row.sopNodes)) {
        const nodeDef = (
          row.sopNodes as Array<{ id: string; name?: string; description?: string }>
        ).find((n) => n.id === currentNodeId)
        currentNodeName = nodeDef?.name ?? nodeDef?.description ?? null
      }
      const nc = nodeCountsMap[row.id]

      return {
        id: row.id,
        sopDefinitionId: row.sopDefinitionId,
        sopName: row.sopName ?? 'Unknown SOP',
        sopVersion: row.sopVersion,
        status: row.status,
        triggeredBy: row.triggeredBy,
        triggeredByName:
          row.triggeredByName ??
          extractSenderName(row.triggerData) ??
          row.triggeredBy ??
          'Unknown user',
        currentNodeName,
        completedNodes: nc?.completed ?? 0,
        totalNodes: nc?.total ?? 0,
        errorMessage: row.errorMessage,
        retryCount: row.retryCount,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }
    })

    logger.info(`Fetched ${rows.length} SOP execution records (page ${page}/${totalPages})`)

    return apiOk(data, {
      extra: { pagination: { page, pageSize, total, totalPages } },
    })
  } catch (error) {
    logger.error('Failed to fetch SOP execution list', error)
    return apiErr('api.task.fetchExecutionsFailed', { status: 500 })
  }
}

/** Extract initiator name from triggerData._meta.senderName */
function extractSenderName(triggerData: unknown): string | null {
  if (!triggerData || typeof triggerData !== 'object') return null
  const meta = (triggerData as Record<string, unknown>)._meta as Record<string, unknown> | undefined
  if (!meta) return null
  return typeof meta.senderName === 'string' ? meta.senderName : null
}
