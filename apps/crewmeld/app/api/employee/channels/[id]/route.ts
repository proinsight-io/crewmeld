import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  tryConnectDiscordGateway,
  tryDisconnectDiscordGateway,
} from '@/lib/channels/plugins/discord/auto-connect'
import { proxyFetch } from '@/lib/channels/proxy-fetch'
import { decryptConfig, encryptConfig, maskSensitiveFields } from '@/lib/connectors/encryption'
import { sanitizeConnectionConfig } from '@/lib/connectors/sanitize'
import type {
  ConnectionConfig,
  ConnectionStatus,
  ConnectionType,
  StatusIndicator,
} from '@/lib/connectors/types'

const logger = createLogger('ChannelDetailAPI')

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

/**
 * GET /api/employee/channels/[id] — Channel detail
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('channel:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const [row] = await db
      .select()
      .from(systemConnections)
      .where(eq(systemConnections.id, id))
      .limit(1)

    if (!row) {
      return apiErr('api.channel.notFound', { status: 404 })
    }

    let config: Record<string, unknown> = {}
    try {
      config = maskSensitiveFields(JSON.parse(decryptConfig(row.configEncrypted)))
    } catch {
      logger.warn(`Failed to decrypt channel config: ${id}`)
    }

    return apiOk({
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      status: row.status,
      statusIndicator: getStatusIndicator(row.status as ConnectionStatus),
      boundEmployeeId: config.boundEmployeeId ?? null,
      webhookUrl: config.webhookUrl ?? null,
      lastHealthCheck: row.lastHealthCheck?.toISOString() ?? null,
      lastHealthMessageI18n: row.lastHealthMessageI18n ?? null,
      createdAt: row.createdAt?.toISOString() ?? '',
      updatedAt: row.updatedAt?.toISOString() ?? '',
      config,
    })
  } catch (error) {
    logger.error('Failed to fetch channel detail', error)
    return apiErr('api.channel.fetchDetailFailed', { status: 500 })
  }
}

/**
 * PATCH /api/employee/channels/[id] — Update channel
 */
async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('channel:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const [existing] = await db
      .select()
      .from(systemConnections)
      .where(eq(systemConnections.id, id))
      .limit(1)

    if (!existing) {
      return apiErr('api.channel.notFound', { status: 404 })
    }

    const body = (await request.json()) as {
      name?: string
      description?: string
      config?: Partial<ConnectionConfig>
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() }

    if (body.name !== undefined) {
      updates.name = body.name
    }
    if (body.description !== undefined) {
      updates.description = body.description
    }
    if (body.config) {
      let existingConfig: ConnectionConfig = {}
      try {
        existingConfig = JSON.parse(decryptConfig(existing.configEncrypted))
      } catch {
        logger.warn(`Failed to decrypt existing config: ${id}`)
      }
      const sanitizedIncoming = sanitizeConnectionConfig(
        existing.type as ConnectionType,
        body.config as Record<string, unknown>
      ) as Partial<ConnectionConfig>
      const mergedConfig = { ...existingConfig, ...sanitizedIncoming }

      // If Telegram and key config updated, rebuild webhookUrl and re-register
      if (existing.type === 'telegram') {
        const baseUrl = process.env.WEBHOOK_BASE_URL || getBaseUrl()
        // Telegram uses connectionId-based routing for precise multi-Bot matching
        const newWebhookUrl = `${baseUrl}/api/channels/telegram/webhook/c/${id}`

        const oldWebhookUrl = existingConfig.webhookUrl as string | undefined
        const botToken = (mergedConfig.telegramBotToken as string) || ''

        // Re-register when webhookUrl or botToken changes
        if (botToken && (newWebhookUrl !== oldWebhookUrl || body.config.telegramBotToken)) {
          mergedConfig.webhookUrl = newWebhookUrl
          try {
            const webhookPayload: Record<string, string> = { url: newWebhookUrl }
            if (mergedConfig.telegramWebhookSecret) {
              webhookPayload.secret_token = mergedConfig.telegramWebhookSecret as string
            }
            logger.info('Telegram setWebhook start (update)', {
              webhookUrl: newWebhookUrl,
              connectionId: id,
            })
            const tgRes = await proxyFetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(webhookPayload),
            })
            const tgData = (await tgRes.json()) as { ok: boolean; description?: string }
            if (!tgData.ok) {
              logger.warn('Telegram setWebhook failed (update)', {
                description: tgData.description,
              })
            } else {
              logger.info('Telegram webhook re-registered successfully', {
                webhookUrl: newWebhookUrl,
              })
            }
          } catch (err) {
            logger.warn('Telegram setWebhook call exception (update)', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      updates.configEncrypted = encryptConfig(JSON.stringify(mergedConfig))
    }

    await db.update(systemConnections).set(updates).where(eq(systemConnections.id, id))

    // Auto-reconnect Discord Gateway after channel update
    if (existing.type === 'discord' && body.config) {
      let fullConfig: ConnectionConfig = {}
      try {
        const encrypted = (updates.configEncrypted as string) ?? existing.configEncrypted
        fullConfig = JSON.parse(decryptConfig(encrypted))
      } catch {
        /* ignore */
      }
      tryConnectDiscordGateway(id, fullConfig).catch((err) => {
        logger.warn('Discord Gateway reconnect failed', { id, error: err })
      })
    }

    return apiOk({ id })
  } catch (error) {
    logger.error('Failed to update channel', error)
    return apiErr('api.channel.updateFailed', { status: 500 })
  }
}

/**
 * DELETE /api/employee/channels/[id] — Delete channel
 */
async function _DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('channel:delete')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const [existing] = await db
      .select()
      .from(systemConnections)
      .where(eq(systemConnections.id, id))
      .limit(1)

    if (!existing) {
      return apiErr('api.channel.notFound', { status: 404 })
    }

    // Disconnect Discord Gateway before channel deletion
    if (existing.type === 'discord') {
      tryDisconnectDiscordGateway(id).catch((err) => {
        logger.warn('Discord Gateway disconnect failed', { id, error: err })
      })
    }

    await db.delete(systemConnections).where(eq(systemConnections.id, id))

    return apiOk({ id })
  } catch (error) {
    logger.error('Failed to delete channel', error)
    return apiErr('api.channel.deleteFailed', { status: 500 })
  }
}

export const PATCH = withAudit(_PATCH)
export const DELETE = withAudit(_DELETE)
