/**
 * POST /api/channels/dingtalk/webhook — DingTalk event callback (generic route)
 *
 * Matches connection credentials by robotCode in the request body.
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { dingtalkPlugin } from '@/lib/channels/plugins/dingtalk'
import type { DingtalkPluginConfig } from '@/lib/channels/plugins/dingtalk/types'
import { handleChannelWebhook } from '@/lib/channels/webhook-handler'
import { resolveAllCredentialsByType } from '@/lib/connectors/resolver'

const logger = createLogger('DingtalkWebhook')

function buildConfig(c: Record<string, unknown>): DingtalkPluginConfig {
  return {
    appKey: (c.appKey as string) ?? '',
    appSecret: (c.appSecret as string) ?? '',
    robotCode: c.robotCode as string | undefined,
    secret: c.secret as string | undefined,
    aesKey: c.aesKey as string | undefined,
    token: c.token as string | undefined,
    suiteKey: (c.suiteKey as string) ?? (c.appKey as string),
    boundEmployeeId: c.boundEmployeeId as string | undefined,
  }
}

export async function POST(request: NextRequest) {
  // Read body text once, then rebuild Request for the handler.
  const bodyText = await request.text()

  // Two DingTalk inbound modes:
  //  - Event subscription (encrypted): body = { encrypt }, signature in query.
  //  - Robot callback (plaintext): body carries robotCode.
  let robotCode: string | undefined
  let encrypt: string | undefined
  try {
    const body = JSON.parse(bodyText) as { robotCode?: string; encrypt?: string }
    robotCode = body.robotCode
    encrypt = body.encrypt
  } catch {
    /* ignore */
  }

  const url = new URL(request.url)
  const msgSignature =
    url.searchParams.get('msg_signature') ?? url.searchParams.get('signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''

  logger.info('DingTalk webhook request received', {
    robotCode,
    hasEncrypt: !!encrypt,
    bodyLen: bodyText.length,
  })

  // Read all DingTalk connections from DB
  const credentials = await resolveAllCredentialsByType('dingtalk')
  if (credentials.length === 0) {
    logger.warn('DingTalk webhook: no available configuration')
    return apiErr('api.channelWebhook.dingtalkNotConfigured', { status: 500 })
  }

  // Identify which connection this event belongs to. Encrypted events carry no
  // plaintext app id, so match by signature — only the connection whose token
  // reproduces the request signature is the right one (same approach as WeCom).
  // Plaintext robot callbacks match by robotCode. Falls back to the first connection.
  let matched = credentials[0]
  if (encrypt && msgSignature && timestamp && nonce) {
    const enc = encrypt
    const { computeDingtalkSignature } = await import('@/lib/channels/dingtalk-crypto')
    const bySignature = credentials.find((cred) => {
      const token = cred.config.token as string | undefined
      if (!token || !cred.config.aesKey) return false
      return computeDingtalkSignature(token, timestamp, nonce, enc) === msgSignature
    })
    if (bySignature) matched = bySignature
  } else if (robotCode) {
    const byRobot = credentials.find(
      (cred) => cred.config.appKey === robotCode || cred.config.robotCode === robotCode
    )
    if (byRobot) matched = byRobot
  }

  const config = buildConfig(matched.config as unknown as Record<string, unknown>)
  // Do NOT gate on a bound employee here. URL verification (check_url), payload
  // decryption, signature checks, and card-action callbacks (resolved by pauseId)
  // must run first and need no employee. handleChannelWebhook verifies first and
  // returns 200 gracefully for actual messages when no employee is bound — so
  // pass through (empty employeeId) instead of failing the whole request with 500.
  const employeeId = config.boundEmployeeId ?? ''
  if (!employeeId) {
    logger.warn(
      'DingTalk webhook: connection has no bound employee (verification + card callbacks still handled)',
      { appKey: config.appKey?.slice(0, 6) }
    )
  }

  // Rebuild Request with the read bodyText to avoid body-already-consumed issue
  const newRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  })

  return handleChannelWebhook(newRequest, {
    plugin: dingtalkPlugin,
    config,
    employeeId,
    connectionId: matched.connectionId,
  })
}
