import { db } from '@crewmeld/db'
import { toolInstances, tools } from '@crewmeld/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { apiAuthErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

/** Flat shape consumed by the employee skill-binding pickers. */
export interface BindableInstance {
  id: string
  templateId: string
  name: string
  templateName: string
  description: string | null
  endpoint: string | null
}

/**
 * GET /api/employee/skills/bindable
 *
 * Returns every deployed tool instance whose template is bindable from the
 * employee skill-binding UI. A template counts as bindable when ANY of:
 *
 *   - `tools.code` is non-null (legacy inline-code tools)
 *   - `tools.source = 'dev-studio'` (dev-studio .cmtool service tools)
 *   - `tools.kind = 'api'` (in-process JS-sandbox API tools)
 *   - `tools.connector_type ->> 'type' = 'openclaw'` (external connector tools)
 *
 * Centralising the predicate here keeps the new-employee wizard and the
 * existing-employee binding tab in sync as new tool kinds are introduced.
 */
export async function GET() {
  const auth = await requirePermission('skill:list')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const rows = await db
    .select({
      id: toolInstances.id,
      templateId: toolInstances.templateId,
      name: toolInstances.name,
      templateName: tools.name,
      description: tools.description,
      deploy: toolInstances.deploy,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(toolInstances.templateId, tools.id))
    .where(
      and(
        sql`${toolInstances.deploy}->>'status' = 'deployed'`,
        sql`(${tools.code} IS NOT NULL OR ${tools.source} = 'dev-studio' OR ${tools.kind} = 'api' OR ${tools.connectorType}->>'type' = 'openclaw')`
      )
    )
    .orderBy(desc(toolInstances.createdAt))

  const instances: BindableInstance[] = rows.map((r) => {
    const trimmed = r.description?.trim()
    return {
      id: r.id,
      templateId: r.templateId,
      name: r.name,
      templateName: r.templateName,
      description: trimmed && trimmed.length > 0 ? trimmed : null,
      endpoint: (r.deploy as { endpoint?: string } | null)?.endpoint ?? null,
    }
  })

  return apiOk(null, { extra: { instances } })
}
