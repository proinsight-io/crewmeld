import { db } from '@crewmeld/db'
import { systemConnections, toolInstances } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { decryptConfig, encryptConfig } from '@/lib/connectors/encryption'
import { sanitizeConnectionConfig } from '@/lib/connectors/sanitize'
import type { ConnectionType } from '@/lib/connectors/types'

const logger = createLogger('ConnectorDetailAPI')

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('connector:list')
    if (auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    const [existing] = await db
      .select()
      .from(systemConnections)
      .where(eq(systemConnections.id, id))
      .limit(1)

    if (!existing) {
      return apiErr('api.connector.notFound', { status: 404 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return apiErr('api.common.invalidBody', { status: 400 })
    }

    const { name, description, config } = body
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    if (typeof name === 'string') {
      if (name.trim().length === 0) {
        return apiErr('api.connector.nameEmpty', { status: 400 })
      }
      if (name.trim().length > 100) {
        return apiErr('api.connector.nameTooLong', { status: 400, params: { max: 100 } })
      }
      updates.name = name.trim()
    }

    if (description !== undefined) {
      updates.description = typeof description === 'string' ? description.trim() : null
    }

    if (config && typeof config === 'object' && !Array.isArray(config)) {
      let existingConfig: Record<string, unknown> = {}
      try {
        existingConfig = JSON.parse(decryptConfig(existing.configEncrypted))
      } catch {
        logger.warn(`Failed to decrypt original config: ${id}`)
      }
      const sanitizedIncoming = sanitizeConnectionConfig(
        existing.type as ConnectionType,
        config as Record<string, unknown>
      ) as Record<string, unknown>

      // OpenClaw endpoints: GET masks `token` (e.g. `abcd****xyz`); if the
      // editor sends a masked token back unchanged, restore the original from
      // `existingConfig` so re-saving without retyping tokens does not corrupt
      // the credential. Match by label first, fall back to index.
      if (existing.type === 'openclaw' && Array.isArray(sanitizedIncoming.endpoints)) {
        const incomingEndpoints = sanitizedIncoming.endpoints as Array<{
          label: string
          url: string
          token: string
        }>
        const existingEndpoints = Array.isArray(existingConfig.endpoints)
          ? (existingConfig.endpoints as Array<{ label?: string; token?: string }>)
          : []
        sanitizedIncoming.endpoints = incomingEndpoints.map((incoming, idx) => {
          if (!incoming.token.includes('****')) return incoming
          const byLabel = existingEndpoints.find((e) => e.label === incoming.label)
          const original = byLabel ?? existingEndpoints[idx]
          if (original && typeof original.token === 'string' && original.token.length > 0) {
            return { ...incoming, token: original.token }
          }
          return incoming
        })
      }

      const mergedConfig = { ...existingConfig, ...sanitizedIncoming }
      updates.configEncrypted = encryptConfig(JSON.stringify(mergedConfig))
    }

    await db.update(systemConnections).set(updates).where(eq(systemConnections.id, id))

    // When connection config changes, mark associated tool instances for redeployment
    // Set deploy.status to 'pending_redeploy' to refresh config on next deployment
    if (updates.configEncrypted) {
      const linkedInstances = await db
        .select({ instanceId: toolInstances.id, deploy: toolInstances.deploy })
        .from(toolInstances)
        .where(eq(toolInstances.connectionId, id))

      if (linkedInstances.length > 0) {
        for (const inst of linkedInstances) {
          const currentDeploy = (inst.deploy as Record<string, unknown>) ?? {}
          // Only trigger redeployment for deployed instances (status is deployed/running)
          if (currentDeploy.status === 'deployed' || currentDeploy.status === 'running') {
            await db
              .update(toolInstances)
              .set({
                deploy: {
                  ...currentDeploy,
                  status: 'pending_redeploy',
                  configChangedAt: new Date().toISOString(),
                },
                updatedAt: new Date(),
              })
              .where(eq(toolInstances.id, inst.instanceId))
          }
        }
        logger.info(
          `Connection config changed, ${linkedInstances.length} tool instances marked for redeployment`,
          { connectionId: id }
        )
      }
    }

    logger.info(`Connection updated: ${id}`)

    return apiOk({
      id,
      name: (updates.name as string) ?? existing.name,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('Failed to update connection', error)
    return apiErr('api.connector.updateFailed', { status: 500 })
  }
}

async function _DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('connector:delete')
    if (auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    const [existing] = await db
      .select({ id: systemConnections.id })
      .from(systemConnections)
      .where(eq(systemConnections.id, id))
      .limit(1)

    if (!existing) {
      return apiErr('api.connector.notFound', { status: 404 })
    }

    // Check if any tool instances are linked to this connection
    const linkedInstances = await db
      .select({ id: toolInstances.id, name: toolInstances.name })
      .from(toolInstances)
      .where(eq(toolInstances.connectionId, id))

    await db.delete(systemConnections).where(eq(systemConnections.id, id))

    logger.info(`Connection deleted: ${id}`)

    // Return linked tool info as hint (connection deleted, tool instances not modified)
    const linkedNames = linkedInstances.map((i) => i.name)

    return apiOk(null, {
      message: 'api.connector.deleted',
      extra: {
        linkedToolInstances: linkedNames.length > 0 ? linkedNames : undefined,
        linkedToolCount: linkedNames.length,
      },
    })
  } catch (error) {
    logger.error('Failed to delete connection', error)
    return apiErr('api.connector.deleteFailed', { status: 500 })
  }
}

export const PATCH = withAudit(_PATCH)
export const DELETE = withAudit(_DELETE)
