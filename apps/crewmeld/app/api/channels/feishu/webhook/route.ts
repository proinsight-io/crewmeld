/**
 * POST /api/channels/feishu/webhook — Feishu (Lark) event callback
 *
 * Uses unified webhook processing pipeline + Feishu plugin.
 * Credentials are read from DB systemConnections; employeeId comes from config.boundEmployeeId.
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { feishuPlugin } from '@/lib/channels/plugins/feishu'
import type { FeishuPluginConfig } from '@/lib/channels/plugins/feishu/types'
import { handleChannelWebhook, parseRequestBody } from '@/lib/channels/webhook-handler'
import { resolveAllCredentialsByType } from '@/lib/connectors/resolver'

const logger = createLogger('FeishuWebhook')

/**
 * Match Feishu connection credentials in DB by appId and convert to FeishuPluginConfig.
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

export async function POST(request: NextRequest) {
  logger.info('========== Feishu webhook request received ==========')

  // Pre-parse body to extract appId (Feishu-specific: credentials depend on app_id in the message)
  const clonedRequest = request.clone()
  const parsed = await parseRequestBody(clonedRequest)

  if (!parsed) {
    logger.warn('Feishu webhook: failed to parse JSON')
    return Response.json({})
  }

  let { body } = parsed
  logger.info('Feishu webhook body', {
    type: body.type,
    hasEncrypt: !!body.encrypt,
    keys: Object.keys(body),
  })

  // Handle URL verification early (no credentials needed)
  if (body.type === 'url_verification') {
    return Response.json({ challenge: body.challenge })
  }

  // Pre-decrypt encrypted messages (must decrypt before extracting appId)
  if (body.encrypt && typeof body.encrypt === 'string') {
    const cred = await resolveFeishuConfig()
    if (!cred?.config.encodingAESKey) {
      logger.warn('Feishu encrypted message but encryptKey not configured')
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

  // Extract appId to match credentials
  const header = body.header as Record<string, unknown> | undefined
  const eventAppId = header?.app_id as string | undefined
  const resolved = await resolveFeishuConfig(eventAppId)

  if (!resolved) {
    logger.warn('Feishu webhook: no matching credential', { appId: eventAppId })
    return Response.json({})
  }

  const { config, connectionId } = resolved
  const employeeId = config.boundEmployeeId ?? ''
  logger.info('Feishu webhook credential matched', {
    appId: eventAppId,
    employeeId,
    hasEmployeeId: !!employeeId,
  })

  return handleChannelWebhook(request, {
    plugin: feishuPlugin,
    config,
    employeeId,
    connectionId,
  })
}
