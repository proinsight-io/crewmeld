/**
 * POST /api/channels/wecom/webhook/[employeeId] — WeCom event callback (multi-employee routing)
 * GET  /api/channels/wecom/webhook/[employeeId] — WeCom URL verification
 *
 * Each digital employee has its own webhook URL.
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { wecomPlugin } from '@/lib/channels/plugins/wecom'
import type { WeComPluginConfig } from '@/lib/channels/plugins/wecom/types'
import { handleWeComWebhook } from '@/lib/channels/webhook-handler'
import { decryptWeComMessage, generateWeComSignature } from '@/lib/channels/wecom-crypto'
import {
  resolveAllCredentialsByType,
  resolveCredentialByBoundEmployee,
} from '@/lib/connectors/resolver'

const logger = createLogger('WeComWebhook:Employee')

/**
 * Resolve the WeCom plugin config for an employee.
 *
 * @returns The config plus the systemConnections row id that received the message
 *   (threaded downstream for SOP-visibility identity resolution), or null.
 */
async function resolveWeComConfig(
  employeeId: string
): Promise<{ config: WeComPluginConfig; connectionId: string } | null> {
  const bound = await resolveCredentialByBoundEmployee(employeeId, 'wecom')
  if (bound) {
    const c = bound.config
    return {
      config: {
        corpId: (c.corpId as string) ?? '',
        corpSecret: (c.corpSecret as string) ?? '',
        agentId: (c.agentId as string) ?? '',
        token: (c.token as string) ?? '',
        encodingAESKey: (c.encodingAESKey as string) ?? '',
        boundEmployeeId: employeeId,
      },
      connectionId: bound.connectionId,
    }
  }

  const credentials = await resolveAllCredentialsByType('wecom')
  if (credentials.length > 0) {
    const c = credentials[0].config
    return {
      config: {
        corpId: (c.corpId as string) ?? '',
        corpSecret: (c.corpSecret as string) ?? '',
        agentId: (c.agentId as string) ?? '',
        token: (c.token as string) ?? '',
        encodingAESKey: (c.encodingAESKey as string) ?? '',
        boundEmployeeId: employeeId,
      },
      connectionId: credentials[0].connectionId,
    }
  }

  return null
}

/**
 * GET — WeCom URL verification
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const url = new URL(request.url)
  const msgSignature = url.searchParams.get('msg_signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''
  const echostr = url.searchParams.get('echostr') ?? ''

  const resolved = await resolveWeComConfig(employeeId)
  if (!resolved) {
    return apiErr('api.channelWebhook.wecomNotConfigured', { status: 500 })
  }

  const { config } = resolved
  const expectedSig = generateWeComSignature(config.token, timestamp, nonce, echostr)
  if (expectedSig !== msgSignature) {
    logger.warn('WeCom URL verification signature mismatch', { employeeId })
    return apiErr('api.channelWebhook.signatureInvalid', { status: 403 })
  }

  const { message: decryptedEchostr } = decryptWeComMessage(config.encodingAESKey, echostr)
  return new Response(decryptedEchostr, { status: 200 })
}

/**
 * POST — WeCom message callback
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params

  if (!employeeId) {
    return apiErr('api.channelWebhook.missingEmployeeId', { status: 400 })
  }

  const resolved = await resolveWeComConfig(employeeId)
  if (!resolved) {
    logger.warn('WeCom webhook: no matching credentials', { employeeId })
    return new Response('success', { status: 200 })
  }

  const { config, connectionId } = resolved
  return handleWeComWebhook(request, {
    plugin: wecomPlugin,
    config,
    employeeId,
    connectionId,
  })
}
