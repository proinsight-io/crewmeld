import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { tryConnectDiscordGateway } from '@/lib/channels/plugins/discord/auto-connect'
import { proxyFetch } from '@/lib/channels/proxy-fetch'
import { decryptConfig, encryptConfig, maskSensitiveFields } from '@/lib/connectors/encryption'
import { sanitizeConnectionConfig, WEBHOOK_CHANNEL_TYPES } from '@/lib/connectors/sanitize'
import type {
  ConnectionConfig,
  ConnectionStatus,
  ConnectionType,
  StatusIndicator,
} from '@/lib/connectors/types'

const logger = createLogger('ChannelAPI')

const CHANNEL_TYPES = [
  'wecom',
  'dingtalk',
  'feishu',
  'email',
  'telegram',
  'discord',
  'wxoa',
] as const

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
 * GET /api/employee/channels — Channel list
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('channel:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const url = new URL(request.url)
    const typeFilter = url.searchParams.get('type')
    const statusFilter = url.searchParams.get('status')
    const search = url.searchParams.get('search')
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize') ?? '12')))

    const filters = [inArray(systemConnections.type, [...CHANNEL_TYPES])]

    if (typeFilter && CHANNEL_TYPES.includes(typeFilter as (typeof CHANNEL_TYPES)[number])) {
      filters.push(eq(systemConnections.type, typeFilter))
    }
    if (statusFilter && statusFilter !== 'all') {
      filters.push(eq(systemConnections.status, statusFilter))
    }
    if (search) {
      filters.push(like(systemConnections.name, `%${search}%`))
    }

    const whereClause = and(...filters)

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(systemConnections)
      .where(whereClause)

    const total = Number(countResult.count)

    const rows = await db
      .select()
      .from(systemConnections)
      .where(whereClause)
      .orderBy(desc(systemConnections.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    const channels = rows.map((row) => {
      let config: Record<string, unknown> = {}
      try {
        config = maskSensitiveFields(JSON.parse(decryptConfig(row.configEncrypted)))
      } catch {
        logger.warn(`Failed to decrypt channel config: ${row.id}`)
      }

      return {
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
      }
    })

    return apiOk(channels, {
      extra: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    logger.error('Failed to fetch channel list', error)
    return apiErr('api.channel.fetchListFailed', { status: 500 })
  }
}

/**
 * POST /api/employee/channels — Create channel
 */
async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('channel:create')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = (await request.json()) as {
      name?: string
      type?: string
      description?: string
      config?: ConnectionConfig
    }

    if (!body.name || !body.type || !body.config) {
      return apiErr('api.channel.requiredFieldsMissing', { status: 400 })
    }

    if (!CHANNEL_TYPES.includes(body.type as (typeof CHANNEL_TYPES)[number])) {
      return apiErr('api.channel.typeUnsupported', {
        status: 400,
        params: { type: body.type },
      })
    }

    if (
      body.type === 'wecom' &&
      (!body.config.corpId || !body.config.corpSecret || !body.config.agentId)
    ) {
      return apiErr('api.channel.wecomFieldsMissing', { status: 400 })
    }

    const id = nanoid()
    const baseUrl = process.env.WEBHOOK_BASE_URL || getBaseUrl()
    const boundEmployeeId = body.config.boundEmployeeId as string | undefined

    // Only inbound-webhook channels need webhookUrl persisted on config
    // (email uses SMTP, discord uses Gateway — no callback URL to store)
    const needsWebhook = WEBHOOK_CHANNEL_TYPES.includes(body.type as ConnectionType)
    const webhookUrl = !needsWebhook
      ? undefined
      : body.type === 'telegram'
        ? `${baseUrl}/api/channels/telegram/webhook/c/${id}`
        : body.type === 'wxoa'
          ? `${baseUrl}/api/channels/wxoa/webhook`
          : boundEmployeeId
            ? `${baseUrl}/api/channels/${body.type}/webhook/${boundEmployeeId}`
            : `${baseUrl}/api/channels/${body.type}/webhook`

    logger.info('Building webhook URL', {
      type: body.type,
      webhookUrl: webhookUrl ?? '(none)',
      connectionId: id,
      boundEmployeeId: boundEmployeeId ?? '(unbound)',
    })

    const sanitizedConfig = sanitizeConnectionConfig(
      body.type as ConnectionType,
      body.config as Record<string, unknown>
    )
    const configWithMeta: ConnectionConfig = webhookUrl
      ? { ...sanitizedConfig, webhookUrl }
      : (sanitizedConfig as ConnectionConfig)
    const encrypted = encryptConfig(JSON.stringify(configWithMeta))

    await db.insert(systemConnections).values({
      id,
      name: body.name,
      type: body.type,
      description: body.description ?? null,
      configEncrypted: encrypted,
      status: 'disconnected',
    })

    // Telegram: auto-call setWebhook to register callback URL (via proxy)
    let webhookRegistered = false
    let webhookWarning: string | undefined
    if (body.type === 'telegram' && body.config.telegramBotToken && webhookUrl) {
      try {
        const setWebhookApiUrl = `https://api.telegram.org/bot${body.config.telegramBotToken}/setWebhook`
        const webhookPayload: Record<string, string> = { url: webhookUrl }
        if (body.config.telegramWebhookSecret) {
          webhookPayload.secret_token = body.config.telegramWebhookSecret
        }
        logger.info('Telegram setWebhook start', { webhookUrl })
        const tgRes = await proxyFetch(setWebhookApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload),
        })
        const tgData = (await tgRes.json()) as { ok: boolean; description?: string }
        if (!tgData.ok) {
          logger.warn('Telegram setWebhook failed', { description: tgData.description, webhookUrl })
          webhookWarning = `Webhook registration failed: ${tgData.description ?? 'Unknown error'}`
        } else {
          logger.info('Telegram webhook registered successfully', { webhookUrl })
          webhookRegistered = true
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn('Telegram setWebhook call exception (HTTPS_PROXY may be required)', {
          error: errMsg,
        })
        webhookWarning = `Webhook registration exception: ${errMsg}`
      }
    }

    // If webhook registration succeeded, update status to connected
    const finalStatus = webhookRegistered ? 'connected' : 'disconnected'
    if (webhookRegistered) {
      await db
        .update(systemConnections)
        .set({ status: finalStatus })
        .where(eq(systemConnections.id, id))
    }

    const maskedConfig = maskSensitiveFields(configWithMeta as Record<string, unknown>)

    // Auto-connect Discord Gateway after channel creation
    if (body.type === 'discord') {
      tryConnectDiscordGateway(id, configWithMeta).catch((err) => {
        logger.warn('Discord Gateway auto-connect failed', { id, error: err })
      })
    }

    return apiOk(
      {
        id,
        name: body.name,
        type: body.type,
        description: body.description ?? null,
        status: finalStatus,
        webhookUrl,
        config: maskedConfig,
        createdAt: new Date().toISOString(),
        webhookWarning: webhookWarning ?? null,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error('Failed to create channel', error)
    return apiErr('api.channel.createFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
