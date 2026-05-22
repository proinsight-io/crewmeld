import { db } from '@crewmeld/db'
import {
  dailyStats,
  digitalEmployees,
  employeeConnections,
  employeeSkillBindings,
  employeeWorkflowBindings,
  modelConfigs,
  sopDefinitions,
  systemConnections,
  taskExecutions,
  workLogs,
} from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { CHANNEL_TYPE_LIST } from '@/lib/connectors/types'
import { makeLogMetadata } from '@/lib/i18n/log-payload'

const logger = createLogger('EmployeeDetailAPI')

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('employee:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const today = new Date().toISOString().slice(0, 10)

    const rows = await db
      .select({
        id: digitalEmployees.id,
        name: digitalEmployees.name,
        avatar: digitalEmployees.avatar,
        description: digitalEmployees.description,
        blockType: digitalEmployees.blockType,
        status: digitalEmployees.status,
        workflowId: digitalEmployees.workflowId,
        modelConfigId: digitalEmployees.modelConfigId,
        config: digitalEmployees.config,
        persona: digitalEmployees.persona,
        activatedAt: digitalEmployees.activatedAt,
        createdAt: digitalEmployees.createdAt,
        updatedAt: digitalEmployees.updatedAt,
        todayTasks: sql<number>`coalesce(${dailyStats.totalTasks}, 0)`.as('today_tasks'),
        successCount: sql<number>`coalesce(${dailyStats.successCount}, 0)`.as('success_count'),
        modelProviderId: modelConfigs.providerId,
        modelDisplayName: modelConfigs.displayName,
        modelModelName: modelConfigs.modelName,
        modelIsActive: modelConfigs.isActive,
      })
      .from(digitalEmployees)
      .leftJoin(
        dailyStats,
        and(eq(dailyStats.employeeId, digitalEmployees.id), eq(dailyStats.statDate, today))
      )
      .leftJoin(modelConfigs, eq(digitalEmployees.modelConfigId, modelConfigs.id))
      .where(eq(digitalEmployees.id, id))
      .limit(1)

    if (rows.length === 0) {
      return apiErr('api.employee.notFound', { status: 404 })
    }

    const row = rows[0]

    const [[wfCount], [skillCount], [connCount]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(employeeWorkflowBindings)
        .where(eq(employeeWorkflowBindings.employeeId, id)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(employeeSkillBindings)
        .where(eq(employeeSkillBindings.employeeId, id)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(employeeConnections)
        .innerJoin(systemConnections, eq(employeeConnections.connectionId, systemConnections.id))
        .where(
          and(
            eq(employeeConnections.employeeId, id),
            notInArray(systemConnections.type, CHANNEL_TYPE_LIST)
          )
        ),
    ])

    const ragflowDatasetIds = Array.isArray(
      (row.config as Record<string, unknown>)?.ragflowDatasetIds
    )
      ? ((row.config as Record<string, unknown>).ragflowDatasetIds as unknown[])
      : []

    const data = {
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      description: row.description,
      blockType: row.blockType,
      status: row.status,
      workflowId: row.workflowId,
      modelConfigId: row.modelConfigId ?? null,
      boundModel: row.modelConfigId
        ? {
            id: row.modelConfigId,
            providerId: row.modelProviderId,
            displayName: row.modelDisplayName,
            modelName: row.modelModelName,
            isActive: row.modelIsActive,
          }
        : null,
      config: row.config,
      persona: row.persona,
      todayTasks: Number(row.todayTasks),
      successRate:
        Number(row.todayTasks) > 0
          ? Number(((Number(row.successCount) / Number(row.todayTasks)) * 100).toFixed(1))
          : 0,
      blockCount: 0,
      workflowBindingCount: Number(wfCount.count),
      skillBindingCount: Number(skillCount.count),
      knowledgeBindingCount: ragflowDatasetIds.length,
      connectionBindingCount: Number(connCount.count),
      activatedAt: row.activatedAt?.toISOString() ?? null,
      createdAt: row.createdAt?.toISOString() ?? '',
      updatedAt: row.updatedAt?.toISOString() ?? '',
    }

    return apiOk(data)
  } catch (error) {
    logger.error('Failed to fetch employee detail', error)
    return apiErr('api.employee.fetchDetailFailed', { status: 500 })
  }
}

async function _DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('employee:delete')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    const existing = await db
      .select({ id: digitalEmployees.id })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, id))
      .limit(1)

    if (existing.length === 0) {
      return apiErr('api.employee.notFound', { status: 404 })
    }

    // Check if any SOP process references this digital employee
    const sopRefs = await db
      .select({ id: sopDefinitions.id, name: sopDefinitions.name })
      .from(sopDefinitions)
      .where(
        and(
          eq(sopDefinitions.isActive, true),
          sql`${sopDefinitions.nodes} @> ${JSON.stringify([{ type: 'digital_employee', executorId: id }])}::jsonb`
        )
      )
      .limit(1)

    if (sopRefs.length > 0) {
      return apiErr('api.employee.inUseBySop', {
        status: 400,
        params: { sopName: sopRefs[0].name },
      })
    }

    await db.delete(digitalEmployees).where(eq(digitalEmployees.id, id))

    logger.info(`Employee ${id} deleted`)

    return apiOk(null, { message: 'api.employee.deleted' })
  } catch (error) {
    logger.error('Failed to delete employee', error)
    return apiErr('api.employee.deleteFailed', { status: 500 })
  }
}

const UpdateEmployeeSchema = z.object({
  persona: z.string().nullable().optional(),
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).nullable().optional(),
  avatar: z.string().min(1).max(16).optional(),
  modelConfigId: z.string().nullable().optional(),
  ragflowDatasetIds: z.array(z.string()).optional(),
})

/**
 * PATCH /api/employee/employees/[id] — Update employee fields
 */
async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('employee:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const body = await request.json()
    const parsed = UpdateEmployeeSchema.safeParse(body)

    if (!parsed.success) {
      return apiErr('api.common.invalidParams', { status: 400 })
    }

    const existing = await db
      .select({
        id: digitalEmployees.id,
        config: digitalEmployees.config,
        modelConfigId: digitalEmployees.modelConfigId,
      })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, id))
      .limit(1)

    if (existing.length === 0) {
      return apiErr('api.employee.notFound', { status: 404 })
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (parsed.data.persona !== undefined) updates.persona = parsed.data.persona
    if (parsed.data.name !== undefined) updates.name = parsed.data.name
    if (parsed.data.description !== undefined) updates.description = parsed.data.description
    if (parsed.data.avatar !== undefined) updates.avatar = parsed.data.avatar
    if (parsed.data.modelConfigId !== undefined) updates.modelConfigId = parsed.data.modelConfigId
    if (parsed.data.ragflowDatasetIds !== undefined) {
      const existingConfig = (existing[0].config as Record<string, unknown>) ?? {}
      updates.config = { ...existingConfig, ragflowDatasetIds: parsed.data.ragflowDatasetIds }
    }

    await db.update(digitalEmployees).set(updates).where(eq(digitalEmployees.id, id))

    // Write work logs for knowledge base and model changes
    const logEntries: Array<{
      content: string
      metadata: Record<string, unknown>
      i18nKey: string
      i18nParams?: Record<string, string | number>
    }> = []

    if (parsed.data.ragflowDatasetIds !== undefined) {
      const oldIds: string[] = Array.isArray(
        (existing[0].config as Record<string, unknown>)?.ragflowDatasetIds
      )
        ? ((existing[0].config as Record<string, unknown>).ragflowDatasetIds as string[])
        : []
      const newIds = parsed.data.ragflowDatasetIds
      const added = newIds.filter((did) => !oldIds.includes(did))
      const removed = oldIds.filter((did) => !newIds.includes(did))
      for (const datasetId of added) {
        logEntries.push({
          content: `Bound knowledge base (ID: ${datasetId})`,
          metadata: { action: 'kb_bind', datasetId },
          i18nKey: 'logActionKbBind',
          i18nParams: { name: datasetId },
        })
      }
      for (const datasetId of removed) {
        logEntries.push({
          content: `Unbound knowledge base (ID: ${datasetId})`,
          metadata: { action: 'kb_unbind', datasetId },
          i18nKey: 'logActionKbUnbind',
          i18nParams: { name: datasetId },
        })
      }
    }

    if (parsed.data.modelConfigId !== undefined) {
      if (parsed.data.modelConfigId === null) {
        logEntries.push({
          content: 'Unbound model',
          metadata: { action: 'model_unbind' },
          i18nKey: 'logActionModelUnbind',
        })
      } else {
        const [modelRow] = await db
          .select({ displayName: modelConfigs.displayName })
          .from(modelConfigs)
          .where(eq(modelConfigs.id, parsed.data.modelConfigId))
          .limit(1)
        const modelName = modelRow?.displayName ?? parsed.data.modelConfigId
        logEntries.push({
          content: `Bound model "${modelName}"`,
          metadata: { action: 'model_bind', modelConfigId: parsed.data.modelConfigId, modelName },
          i18nKey: 'logActionModelBind',
          i18nParams: { name: modelName },
        })
      }
    }

    for (const entry of logEntries) {
      const now = new Date()
      const taskId = `task_${nanoid()}`
      await db.insert(taskExecutions).values({
        id: taskId,
        employeeId: id,
        triggerType: 'manual',
        status: 'success',
        input: entry.metadata,
        inputSummary: entry.content,
        outputSummary: entry.content,
        durationMs: 0,
        startedAt: now,
        completedAt: now,
      })
      await db.insert(workLogs).values({
        id: `log_${nanoid()}`,
        taskId,
        employeeId: id,
        logType: 'action',
        content: entry.content,
        metadata: makeLogMetadata(entry.metadata, {
          i18nKey: entry.i18nKey,
          i18nParams: entry.i18nParams,
        }),
      })
    }

    logger.info(`Employee ${id} updated`)

    return apiOk({ id, ...parsed.data })
  } catch (error) {
    logger.error('Failed to update employee', error)
    return apiErr('api.employee.updateFailed', { status: 500 })
  }
}

export const PATCH = withAudit(_PATCH)
export const DELETE = withAudit(_DELETE)
