/**
 * POST /api/channels/feishu/webhook/[employeeId] — Feishu event callback (multi-employee routing)
 *
 * Each digital employee has its own webhook URL.
 * employeeId comes from the URL path parameter (not config.boundEmployeeId).
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { feishuPlugin } from '@/lib/channels/plugins/feishu'
import type { FeishuPluginConfig } from '@/lib/channels/plugins/feishu/types'
import { handleChannelWebhook, parseRequestBody } from '@/lib/channels/webhook-handler'
import { resolveAllCredentialsByType } from '@/lib/connectors/resolver'

const logger = createLogger('FeishuWebhook:Employee')

/**
 * Match Feishu connection credentials in DB by appId.
 *
 * @returns The matched config plus the systemConnections row id that received the
 *   message (threaded downstream for SOP-visibility identity resolution), or null.
 */
async function resolveFeishuConfig(
  appId?: string
): Promise<{ config: FeishuPluginConfig; connectionId: string } | null> {
  const credentials = await resolveAllCredentialsByType('feishu')

  if (appId) {
    for (const cred of credentials) {
      if (cred.config.appId === appId) {
        return {
          config: cred.config as unknown as FeishuPluginConfig,
          connectionId: cred.connectionId,
        }
      }
    }
  }

  if (credentials.length > 0) {
    return {
      config: credentials[0].config as unknown as FeishuPluginConfig,
      connectionId: credentials[0].connectionId,
    }
  }

  return null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params

  if (!employeeId) {
    return apiErr('api.channelWebhook.missingEmployeeId', { status: 400 })
  }

  const clonedRequest = request.clone()
  const parsed = await parseRequestBody(clonedRequest)

  if (!parsed) {
    logger.warn('Feishu webhook: JSON parse failed', { employeeId })
    return Response.json({})
  }

  let { body } = parsed

  if (body.type === 'url_verification') {
    return Response.json({ challenge: body.challenge })
  }

  if (body.encrypt && typeof body.encrypt === 'string') {
    const cred = await resolveFeishuConfig()
    if (!cred?.config.encodingAESKey) {
      logger.warn('Feishu encrypted message but encryptKey not configured', { employeeId })
      return Response.json({})
    }
    const decrypted = feishuPlugin.inbound.decryptPayload?.(body, cred.config)
    if (decrypted) {
      body = decrypted
      if (body.type === 'url_verification') {
        return Response.json({ challenge: body.challenge })
      }
    }
  }

  const header = body.header as Record<string, unknown> | undefined
  const eventAppId = header?.app_id as string | undefined
  const resolved = await resolveFeishuConfig(eventAppId)

  if (!resolved) {
    logger.warn('Feishu webhook: no matching credentials', { appId: eventAppId, employeeId })
    return Response.json({})
  }

  const { config, connectionId } = resolved
  return handleChannelWebhook(request, {
    plugin: feishuPlugin,
    config,
    employeeId,
    connectionId,
  })
}
