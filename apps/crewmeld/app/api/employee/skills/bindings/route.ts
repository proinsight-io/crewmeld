import { randomUUID } from 'crypto'
import { db } from '@crewmeld/db'
import {
  digitalEmployees,
  employeeSkillBindings,
  taskExecutions,
  toolInstances,
  tools,
  workLogs,
} from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { makeLogMetadata } from '@/lib/i18n/log-payload'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { t } from '@/lib/i18n/server-t'

const logger = createLogger('SkillBindingsAPI')

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('skill:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const url = new URL(request.url)
    const employeeId = url.searchParams.get('employeeId')

    if (!employeeId) {
      return apiErr('api.skill.bindingEmployeeIdRequired', { status: 400 })
    }

    const rows = await db
      .select({
        bindingId: employeeSkillBindings.id,
        skillId: employeeSkillBindings.skillId,
        instanceId: employeeSkillBindings.instanceId,
        createdAt: employeeSkillBindings.createdAt,
        skillName: tools.name,
        skillDescription: tools.description,
        instanceName: toolInstances.name,
        instanceDeploy: toolInstances.deploy,
      })
      .from(employeeSkillBindings)
      .innerJoin(toolInstances, eq(employeeSkillBindings.instanceId, toolInstances.id))
      .innerJoin(tools, eq(toolInstances.templateId, tools.id))
      .where(eq(employeeSkillBindings.employeeId, employeeId))

    const bindings = rows.map((row) => {
      const deploy = row.instanceDeploy as { status?: string; endpoint?: string } | null
      return {
        bindingId: row.bindingId,
        skillId: row.skillId,
        instanceId: row.instanceId,
        skillName: row.skillName ?? 'Unknown tool',
        instanceName: row.instanceName ?? 'Unknown instance',
        skillDescription: row.skillDescription ?? null,
        deployStatus: deploy?.status ?? 'not_deployed',
        endpoint: deploy?.endpoint ?? null,
        createdAt: row.createdAt?.toISOString() ?? '',
      }
    })

    return apiOk(null, { extra: { bindings } })
  } catch (error) {
    logger.error('Failed to fetch tool binding list', error)
    return apiErr('api.skill.fetchBindingsFailed', { status: 500 })
  }
}

async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('skill:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const locale = resolveLocale(request)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return apiErr('api.common.invalidBody', { status: 400 })
    }

    const { employeeId, instanceId } = body

    if (!employeeId || typeof employeeId !== 'string') {
      return apiErr('api.skill.bindingEmployeeIdRequired', { status: 400 })
    }
    if (!instanceId || typeof instanceId !== 'string') {
      return apiErr('api.skill.bindingInstanceIdRequired', { status: 400 })
    }

    const [employee] = await db
      .select({ id: digitalEmployees.id })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, employeeId))
      .limit(1)

    if (!employee) {
      return apiErr('api.skill.bindingEmployeeNotFound', { status: 404 })
    }

    const [instance] = await db
      .select({
        id: toolInstances.id,
        templateId: toolInstances.templateId,
        deploy: toolInstances.deploy,
        instanceName: toolInstances.name,
      })
      .from(toolInstances)
      .where(eq(toolInstances.id, instanceId))
      .limit(1)

    if (!instance) {
      return apiErr('api.skill.bindingInstanceNotFound', { status: 404 })
    }

    const deploy = instance.deploy as { status?: string } | null
    if (deploy?.status !== 'deployed') {
      return apiErr('api.skill.bindingInstanceNotDeployed', { status: 400 })
    }

    // Dedup by instance, not template: a template may have several instances
    // (distinct presetParams/env), and an employee may bind more than one of
    // them. Matches the (employee_id, instance_id) unique index; only re-binding
    // the SAME instance is a duplicate.
    const [existing] = await db
      .select({ id: employeeSkillBindings.id })
      .from(employeeSkillBindings)
      .where(
        and(
          eq(employeeSkillBindings.employeeId, employeeId),
          eq(employeeSkillBindings.instanceId, instanceId)
        )
      )
      .limit(1)

    if (existing) {
      return apiErr('api.skill.bindingDuplicate', { status: 409 })
    }

    const bindingId = randomUUID()
    await db.insert(employeeSkillBindings).values({
      id: bindingId,
      employeeId,
      skillId: instance.templateId,
      instanceId,
    })

    const [toolRow] = await db
      .select({ name: tools.name })
      .from(tools)
      .where(eq(tools.id, instance.templateId))
      .limit(1)
    const toolName = toolRow?.name ?? instance.instanceName
    const now = new Date()
    const taskId = `task_${nanoid()}`
    await db.insert(taskExecutions).values({
      id: taskId,
      employeeId,
      triggerType: 'manual',
      status: 'success',
      input: { action: 'tool_bind', instanceId },
      inputSummary: t('api.workLog.toolBound', { name: toolName }, 'en'),
      outputSummary: t('api.workLog.toolBound', { name: toolName }, 'en'),
      durationMs: 0,
      startedAt: now,
      completedAt: now,
    })
    await db.insert(workLogs).values({
      id: `log_${nanoid()}`,
      taskId,
      employeeId,
      logType: 'action',
      content: `${t('api.workLog.toolBound', { name: toolName }, 'en')} (instance: ${instance.instanceName})`,
      metadata: makeLogMetadata(
        { action: 'tool_bind', instanceId, toolName, instanceName: instance.instanceName },
        {
          i18nKey: 'logActionToolBindInstance',
          i18nParams: { name: toolName, instance: instance.instanceName },
        }
      ),
    })

    logger.info(`Tool binding created: employee=${employeeId}, instance=${instanceId}`)

    return apiOk(null, {
      status: 201,
      extra: {
        id: bindingId,
        employeeId,
        instanceId,
        createdAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error('Failed to create tool binding', error)
    return apiErr('api.skill.createBindingFailed', { status: 500 })
  }
}

async function _DELETE(request: NextRequest) {
  try {
    const auth = await requirePermission('skill:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const locale = resolveLocale(request)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return apiErr('api.common.invalidBody', { status: 400 })
    }

    const { id } = body
    if (!id || typeof id !== 'string') {
      return apiErr('api.skill.bindingIdRequired', { status: 400 })
    }

    const [existing] = await db
      .select({
        id: employeeSkillBindings.id,
        employeeId: employeeSkillBindings.employeeId,
        skillId: employeeSkillBindings.skillId,
        instanceId: employeeSkillBindings.instanceId,
        instanceName: toolInstances.name,
        toolName: tools.name,
      })
      .from(employeeSkillBindings)
      .innerJoin(toolInstances, eq(employeeSkillBindings.instanceId, toolInstances.id))
      .innerJoin(tools, eq(employeeSkillBindings.skillId, tools.id))
      .where(eq(employeeSkillBindings.id, id))
      .limit(1)

    if (!existing) {
      return apiErr('api.skill.bindingNotFound', { status: 404 })
    }

    await db.delete(employeeSkillBindings).where(eq(employeeSkillBindings.id, id))

    const now = new Date()
    const taskId = `task_${nanoid()}`
    await db.insert(taskExecutions).values({
      id: taskId,
      employeeId: existing.employeeId,
      triggerType: 'manual',
      status: 'success',
      input: { action: 'tool_unbind', instanceId: existing.instanceId },
      inputSummary: t('api.workLog.toolUnbound', { name: existing.toolName }, 'en'),
      outputSummary: t('api.workLog.toolUnbound', { name: existing.toolName }, 'en'),
      durationMs: 0,
      startedAt: now,
      completedAt: now,
    })
    await db.insert(workLogs).values({
      id: `log_${nanoid()}`,
      taskId,
      employeeId: existing.employeeId,
      logType: 'action',
      content: `${t('api.workLog.toolUnbound', { name: existing.toolName }, 'en')} (instance: ${existing.instanceName})`,
      metadata: makeLogMetadata(
        {
          action: 'tool_unbind',
          instanceId: existing.instanceId,
          toolName: existing.toolName,
          instanceName: existing.instanceName,
        },
        {
          i18nKey: 'logActionToolUnbindInstance',
          i18nParams: { name: existing.toolName, instance: existing.instanceName },
        }
      ),
    })

    logger.info(`Tool binding deleted: ${id}`)

    return apiOk(null)
  } catch (error) {
    logger.error('Failed to delete tool binding', error)
    return apiErr('api.skill.deleteBindingFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
export const DELETE = withAudit(_DELETE)
