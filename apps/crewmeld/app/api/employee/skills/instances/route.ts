import { randomUUID } from 'crypto'
import { db } from '@crewmeld/db'
import { systemConnections, toolInstances, tools } from '@crewmeld/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { DeployInfo, ToolInstance } from '@/app/(employee)/skills/types'

function rowToInstance(
  row: typeof toolInstances.$inferSelect,
  connectionName?: string | null
): ToolInstance {
  return {
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    connectionId: row.connectionId,
    connectionName: connectionName ?? null,
    presetParams: row.presetParams as ToolInstance['presetParams'],
    envVars: row.envVars as ToolInstance['envVars'],
    deploy: row.deploy as ToolInstance['deploy'],
    publishedAsApi: row.publishedAsApi,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function GET(request: NextRequest) {
  const auth = await requirePermission('skill:list')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const url = new URL(request.url)
  const templateId = url.searchParams.get('templateId')
  const countsOnly = url.searchParams.get('counts') === 'true'

  if (countsOnly) {
    const rows = await db
      .select({
        templateId: toolInstances.templateId,
        deploy: toolInstances.deploy,
      })
      .from(toolInstances)

    const counts: Record<string, { total: number; deployed: number }> = {}
    for (const row of rows) {
      if (!counts[row.templateId]) {
        counts[row.templateId] = { total: 0, deployed: 0 }
      }
      counts[row.templateId].total++
      if ((row.deploy as Record<string, unknown> | null)?.status === 'deployed') {
        counts[row.templateId].deployed++
      }
    }

    return apiOk(null, { extra: { counts } })
  }

  if (!templateId) {
    return apiErr('api.skill.missingTemplateId', { status: 400 })
  }

  const rows = await db
    .select({
      instance: toolInstances,
      connectionName: systemConnections.name,
    })
    .from(toolInstances)
    .leftJoin(systemConnections, eq(toolInstances.connectionId, systemConnections.id))
    .where(eq(toolInstances.templateId, templateId))
    .orderBy(desc(toolInstances.createdAt))

  return apiOk(null, {
    extra: { instances: rows.map((r) => rowToInstance(r.instance, r.connectionName)) },
  })
}

async function _POST(request: NextRequest) {
  const auth = await requirePermission('skill:create')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const body = await request.json()
  const { templateId, name, presetParams, envVars, connectionId } = body as {
    templateId: string
    name?: string
    presetParams?: Record<string, string>
    envVars?: Array<{ name: string; value: string }>
    connectionId?: string
  }

  if (!templateId) {
    return apiErr('api.skill.missingTemplateId', { status: 400 })
  }

  const [template] = await db
    .select({ id: tools.id, name: tools.name, connectorType: tools.connectorType })
    .from(tools)
    .where(eq(tools.id, templateId))
    .limit(1)

  if (!template) {
    return apiErr('api.skill.templateNotFound', { status: 404 })
  }

  const existing = await db
    .select({ id: toolInstances.id })
    .from(toolInstances)
    .where(eq(toolInstances.templateId, templateId))

  const count = existing.length
  const instanceName = name ?? (count === 0 ? template.name : `${template.name}${count + 1}`)

  const now = new Date()
  const instanceId = `inst-${randomUUID()}`

  /** Auto-mark OpenClaw instances as deployed with a sentinel endpoint. */
  const ct = template.connectorType as { type?: string } | null
  const isOpenclaw = ct?.type === 'openclaw'

  const deployField: DeployInfo | null = isOpenclaw
    ? {
        status: 'deployed',
        endpoint: 'openclaw://internal',
        deployedAt: now.toISOString(),
      }
    : null

  await db.insert(toolInstances).values({
    id: instanceId,
    templateId,
    name: instanceName,
    connectionId: connectionId ?? null,
    presetParams: presetParams ?? null,
    envVars: envVars ?? null,
    deploy: deployField,
    createdBy: auth.userId!,
    createdAt: now,
    updatedAt: now,
  })

  return apiOk(null, {
    status: 201,
    extra: {
      instance: {
        id: instanceId,
        templateId,
        name: instanceName,
        connectionId: connectionId ?? null,
        presetParams: presetParams ?? undefined,
        envVars: envVars ?? undefined,
        deploy: deployField ?? undefined,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      } satisfies ToolInstance,
    },
  })
}

export const POST = withAudit(_POST)
