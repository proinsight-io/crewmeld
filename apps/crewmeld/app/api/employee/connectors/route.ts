import { db } from '@crewmeld/db'
import { CONNECTION_TYPES, systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq, notInArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { decryptConfig, encryptConfig, maskSensitiveFields } from '@/lib/connectors/encryption'
import { sanitizeConnectionConfig } from '@/lib/connectors/sanitize'
import type { ConnectionStatus, StatusIndicator } from '@/lib/connectors/types'
import { CHANNEL_TYPE_LIST } from '@/lib/connectors/types'
import { maskSensitive } from '@/lib/dev-studio/connection-resolver'

const logger = createLogger('ConnectorsAPI')

function getStatusIndicator(status: ConnectionStatus): StatusIndicator {
  switch (status) {
    case 'connected':
      return 'green'
    case 'error':
      return 'red'
    case 'testing':
      return 'yellow'
    default:
      return 'gray'
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('connector:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const url = new URL(request.url)
    const typeFilter = url.searchParams.get('type')
    const statusFilter = url.searchParams.get('status')
    const subtypeFilter = url.searchParams.get('subtype')
    const withConfig = url.searchParams.get('withConfig') === 'true'

    const filters = [
      // Exclude message channel types, channels are managed by /api/employee/channels
      notInArray(systemConnections.type, [...CHANNEL_TYPE_LIST]),
    ]
    if (typeFilter && typeFilter !== 'all') {
      filters.push(eq(systemConnections.type, typeFilter))
    }
    if (statusFilter && statusFilter !== 'all') {
      filters.push(eq(systemConnections.status, statusFilter))
    }

    const rows = await db
      .select()
      .from(systemConnections)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(systemConnections.createdAt)

    const connections: Array<Record<string, unknown>> = []
    for (const row of rows) {
      let config: Record<string, unknown> = {}
      let decrypted: Record<string, unknown> = {}
      try {
        decrypted = JSON.parse(decryptConfig(row.configEncrypted)) as Record<string, unknown>
        config = maskSensitiveFields({ ...decrypted })
      } catch {
        logger.warn(`Failed to decrypt connection config: ${row.id}`)
      }

      // Post-query subtype filter: check the decrypted config's dbType field
      if (subtypeFilter) {
        const dbType = typeof decrypted.dbType === 'string' ? decrypted.dbType : undefined
        if (dbType !== subtypeFilter) continue
      }

      const entry: Record<string, unknown> = {
        id: row.id,
        name: row.name,
        type: row.type,
        description: row.description,
        status: row.status,
        statusIndicator: getStatusIndicator(row.status as ConnectionStatus),
        lastHealthCheck: row.lastHealthCheck?.toISOString() ?? null,
        lastHealthMessageI18n: row.lastHealthMessageI18n ?? null,
        createdAt: row.createdAt?.toISOString() ?? '',
        updatedAt: row.updatedAt?.toISOString() ?? '',
        config,
      }

      if (withConfig) {
        const preview: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(decrypted)) {
          preview[k] = maskSensitive(k, v)
        }
        entry.configPreview = preview
      }

      connections.push(entry)
    }

    return apiOk({ connections, total: connections.length })
  } catch (error) {
    logger.error('Failed to fetch connection list', error)
    return apiErr('api.connector.fetchListFailed', { status: 500 })
  }
}

async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('connector:create')
    if (auth.error) {
      return apiAuthErr(auth)
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return apiErr('api.common.invalidBody', { status: 400 })
    }

    const { name, type, description, config } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return apiErr('api.connector.nameEmpty', { status: 400 })
    }
    if (typeof name === 'string' && name.trim().length > 100) {
      return apiErr('api.connector.nameTooLong', { status: 400, params: { max: 100 } })
    }
    if (
      !type ||
      typeof type !== 'string' ||
      !CONNECTION_TYPES.includes(type as (typeof CONNECTION_TYPES)[number])
    ) {
      return apiErr('api.connector.typeInvalid', { status: 400 })
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return apiErr('api.connector.configEmpty', { status: 400 })
    }

    const connId = `conn_${nanoid(16)}`
    const sanitized = sanitizeConnectionConfig(
      type as (typeof CONNECTION_TYPES)[number],
      config as Record<string, unknown>
    )
    const configEncrypted = encryptConfig(JSON.stringify(sanitized))

    await db.insert(systemConnections).values({
      id: connId,
      name: (name as string).trim(),
      type: type as string,
      description: typeof description === 'string' ? description.trim() : null,
      configEncrypted,
      status: 'disconnected',
    })

    logger.info(`Connection created: ${name} (${connId}), type=${type}`)

    return apiOk(
      {
        id: connId,
        name: (name as string).trim(),
        type,
        status: 'disconnected',
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error('Failed to create connection', error)
    return apiErr('api.connector.createFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
