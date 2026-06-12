/**
 * POST /api/employee/skills/import-api
 *
 * Import a .cmapi package (plain-JSON API tool export).
 *
 * Accepts a JSON body `{ package: <parsed .cmapi object>, mapping: Record<string,string> }`.
 * The flow:
 *   1. Authenticate and require `skill:create` permission.
 *   2. Parse body; validate the package via `parseApiToolPackage` (422 on failure).
 *   3. Rewrite connection ids via `rebuildApiSpecFromPackage` using the caller's mapping.
 *   4. Insert a new `tools` row (fresh nanoid, kind='api').
 *   5. Insert a default `tool_instances` row tied to the new template.
 *
 * The imported tool is always a new copy — no deduplication by name or content.
 */
import { db, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  parseApiToolPackage,
  rebuildApiSpecFromPackage,
} from '@/lib/tools/api-tool-package'
import type { DeployInfo } from '@/app/(employee)/skills/types'

const logger = createLogger('import-api')

async function _POST(request: NextRequest) {
  const auth = await requirePermission('skill:create')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  let body: { package?: unknown; mapping?: Record<string, string> }
  try {
    body = await request.json()
  } catch {
    return apiErr('api.skill.importApiInvalid', { status: 400 })
  }

  let pkg: ReturnType<typeof parseApiToolPackage>
  try {
    pkg = parseApiToolPackage(body.package)
  } catch (err) {
    logger.warn('.cmapi parse failed', (err as Error).message)
    return apiErr('api.skill.importApiInvalid', { status: 422 })
  }

  const apiSpec = rebuildApiSpecFromPackage(pkg, body.mapping ?? {})

  const toolId = nanoid()
  const now = new Date()

  try {
    await db.insert(tools).values({
      id: toolId,
      name: pkg.name,
      description: pkg.description,
      version: pkg.toolVersion,
      kind: 'api',
      apiSpec,
      parameters: pkg.parameters ?? null,
      source: 'installed',
      language: 'javascript',
      createdBy: auth.userId!,
      createdAt: now,
      updatedAt: now,
    })

    // API tools run in an in-process JS sandbox: no K8S deployment, so mark the
    // instance deployed up front so it surfaces in the employee binding picker
    // (which only lists deployed instances).
    const deploy: DeployInfo = { status: 'deployed', deployedAt: now.toISOString() }
    await db.insert(toolInstances).values({
      id: nanoid(),
      templateId: toolId,
      name: pkg.name,
      deploy,
      createdBy: auth.userId!,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    logger.error('api tool insert failed', (err as Error).message, toolId)
    return apiErr('api.skill.importApiFailed', { status: 500 })
  }

  logger.info('.cmapi imported', toolId, pkg.name)
  return apiOk({ toolId, name: pkg.name })
}

export const POST = withAudit(_POST)
