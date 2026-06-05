import { db } from '@crewmeld/db'
import { toolInstances } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { undeploySkill } from '@/lib/k8s/deploy-skill'
import type { DeployInfo } from '@/app/(employee)/skills/types'

const logger = createLogger('InstanceAPI')

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params
  const body = await request.json()
  const { name, presetParams, envVars, connectionId } = body as {
    name?: string
    presetParams?: Record<string, string>
    envVars?: Array<{ name: string; value: string }>
    connectionId?: string | null
  }

  const [existing] = await db
    .select({ id: toolInstances.id })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!existing) {
    return apiErr('api.skill.instanceNotFound', { status: 404 })
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (name !== undefined) updates.name = name
  if (presetParams !== undefined) updates.presetParams = presetParams
  if (envVars !== undefined) updates.envVars = envVars
  if (connectionId !== undefined) updates.connectionId = connectionId

  await db.update(toolInstances).set(updates).where(eq(toolInstances.id, id))

  return apiOk(null)
}

async function _DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:delete')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  const [existing] = await db
    .select({ id: toolInstances.id, deploy: toolInstances.deploy })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!existing) {
    return apiErr('api.skill.instanceNotFound', { status: 404 })
  }

  const deploy = existing.deploy as DeployInfo | null
  if (deploy?.status === 'deployed') {
    try {
      if (deploy.deployType === 'opensandbox-script') {
        // Script-type dev-studio tool: no persistent sandbox to tear down.
        // Code stays on NFS until the tool itself is deleted.
      } else if (deploy.deployType === 'opensandbox' && deploy.sandboxId) {
        const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
        const client = getOpenSandboxClient()
        await client.destroy(deploy.sandboxId)
      } else {
        await undeploySkill(id)
      }
      logger.info('Auto-undeployed instance before delete', { id, deployType: deploy.deployType })
    } catch (err) {
      logger.warn(
        `Undeploy before delete failed, proceeding: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  await db.delete(toolInstances).where(eq(toolInstances.id, id))

  return apiOk(null)
}

export const PATCH = withAudit(_PATCH)
export const DELETE = withAudit(_DELETE)
