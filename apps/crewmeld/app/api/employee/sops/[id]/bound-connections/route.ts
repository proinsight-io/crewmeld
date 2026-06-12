import { db } from '@crewmeld/db'
import { employeeConnections, sopDefinitions, systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq, inArray } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import type { BoundConnection } from '@/components/sop/permission/permission-panel'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { SopNode } from '@/types/sop'

const logger = createLogger('API:Sops:BoundConnections')

/**
 * Connection types that carry an organization directory and therefore support
 * identity-based visibility matching. Other channels (web/discord/telegram/…)
 * have no org directory and are excluded from the permission panel tabs.
 */
const IDENTITY_CAPABLE_TYPES = new Set(['feishu', 'dingtalk', 'wecom'])

/**
 * Synthetic "Web" connection, always present as the first permission tab. Every
 * digital employee is reachable via the platform chat console, so web access is
 * always gateable — independent of any bound IM connection.
 */
const WEB_CONNECTION: BoundConnection = { id: 'web', name: 'Web', type: 'web' }

/**
 * List the channel connections bound to the digital employees referenced by a
 * SOP's nodes. Used to populate the SOP permission editor's per-channel tabs.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('sop:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    const rows = await db
      .select({ nodes: sopDefinitions.nodes })
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, id))
    const definition = rows[0]

    if (!definition) {
      return apiErr('api.sop.notFound', { status: 404 })
    }

    const nodes = (definition.nodes ?? []) as SopNode[]
    const employeeIds = Array.from(
      new Set(
        nodes
          .filter((node) => node.type === 'digital_employee' && node.executorId)
          .map((node) => node.executorId as string)
      )
    )

    if (employeeIds.length === 0) {
      return apiOk({ connections: [WEB_CONNECTION] })
    }

    const bindings = await db
      .select({
        connectionId: systemConnections.id,
        name: systemConnections.name,
        type: systemConnections.type,
      })
      .from(employeeConnections)
      .innerJoin(systemConnections, eq(employeeConnections.connectionId, systemConnections.id))
      .where(inArray(employeeConnections.employeeId, employeeIds))

    const byId = new Map<string, BoundConnection>()
    for (const binding of bindings) {
      if (!IDENTITY_CAPABLE_TYPES.has(binding.type)) continue
      if (byId.has(binding.connectionId)) continue
      byId.set(binding.connectionId, {
        id: binding.connectionId,
        name: binding.name,
        type: binding.type,
      })
    }

    return apiOk({ connections: [WEB_CONNECTION, ...byId.values()] })
  } catch (error) {
    logger.error('Failed to list SOP bound connections', error)
    return apiErr('api.sop.fetchDetailFailed', { status: 500 })
  }
}
