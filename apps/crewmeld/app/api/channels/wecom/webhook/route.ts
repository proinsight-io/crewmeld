/**
 * GET/POST /api/channels/wecom/webhook — WeCom event callback
 *
 * GET: URL verification (echostr decryption)
 * POST: Message reception + approval card callback
 *
 * Uses unified webhook processing pipeline + WeCom plugin.
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { wecomPlugin } from '@/lib/channels/plugins/wecom'
import type { WeComPluginConfig } from '@/lib/channels/plugins/wecom/types'
import { handleWeComWebhook } from '@/lib/channels/webhook-handler'
import { extractXmlTag } from '@/lib/channels/wecom-adapter'
import { decryptWeComMessage, generateWeComSignature } from '@/lib/channels/wecom-crypto'
import { resolveAllCredentialsByType } from '@/lib/connectors/resolver'

const logger = createLogger('WecomWebhook')

/**
 * GET /api/channels/wecom/webhook — URL verification
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const msgSignature = url.searchParams.get('msg_signature') ?? ''
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''

    // echostr is base64 ciphertext that may contain '+'; URLSearchParams decodes '+' as space
    // Extract from raw query string first to preserve '+' signs
    let echostr = ''
    const rawQuery = url.search.slice(1) // strip leading '?'
    const echoMatch = rawQuery.match(/echostr=([^&]*)/)
    if (echoMatch) {
      echostr = decodeURIComponent(echoMatch[1])
    } else {
      echostr = url.searchParams.get('echostr') ?? ''
    }

    logger.info('========== WeCom GET verification request ==========', {
      msgSignature: msgSignature.slice(0, 10),
      timestamp,
      nonce,
      hasEchostr: !!echostr,
      echostrLen: echostr.length,
    })

    if (!msgSignature || !echostr) {
      logger.warn('GET verification: missing msg_signature or echostr')
      return new Response('ok', { status: 200 })
    }

    const credentials = await resolveAllCredentialsByType('wecom')
    logger.info('GET verification: fetched credentials', { count: credentials.length })

    for (const cred of credentials) {
      const { token, encodingAESKey } = cred.config
      if (!token || !encodingAESKey) continue

      const sig = generateWeComSignature(token, timestamp, nonce, echostr)
      if (sig === msgSignature) {
        try {
          const { message: decrypted } = decryptWeComMessage(encodingAESKey, echostr)
          logger.info('GET verification successful', { decryptedLen: decrypted.length })
          return new Response(decrypted, { status: 200, headers: { 'Content-Type': 'text/plain' } })
        } catch (error) {
          logger.error('echostr decryption failed', error)
          return apiErr('api.channelWebhook.decryptFailed', { status: 400 })
        }
      } else {
        logger.info('GET verification: signature mismatch', {
          credId: cred.connectionId,
          computed: sig.slice(0, 10),
          expected: msgSignature.slice(0, 10),
        })
      }
    }

    logger.warn('URL verification failed: no matching credentials')
    return apiErr('api.channelWebhook.signatureInvalid', { status: 403 })
  } catch (error) {
    logger.error('GET verification error', error)
    return apiErr('api.channelWebhook.internalError', { status: 500 })
  }
}

/**
 * POST /api/channels/wecom/webhook — Receive messages
 */
export async function POST(request: NextRequest) {
  // Read body text, extract ToUserName to match credentials, then rebuild Request for handler
  const bodyText = await request.text()
  logger.info('========== WeCom POST request ==========', { bodyLen: bodyText.length })

  const toUserName = extractXmlTag(bodyText, 'ToUserName')

  const credentials = await resolveAllCredentialsByType('wecom')
  let config: WeComPluginConfig | null = null
  // Id of the systemConnections row that received this message; threaded downstream
  // for SOP-visibility identity resolution.
  let connectionId: string | undefined

  // Multiple WeCom connections may share the same corpId but have different tokens (different apps)
  // Try signature verification one by one; the one that matches is the correct connection
  const encryptedContent = extractXmlTag(bodyText, 'Encrypt') ?? ''
  const url = new URL(request.url)
  const msgSignature = url.searchParams.get('msg_signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''

  for (const cred of credentials) {
    if (cred.config.corpId !== toUserName && toUserName) continue
    if (!cred.config.token || !cred.config.encodingAESKey) continue

    const sig = generateWeComSignature(cred.config.token, timestamp, nonce, encryptedContent)
    if (sig === msgSignature) {
      config = cred.config as unknown as WeComPluginConfig
      connectionId = cred.connectionId
      break
    }
  }

  // Fallback: if signature matching fails, use the first one matching corpId
  if (!config) {
    for (const cred of credentials) {
      if (cred.config.corpId === toUserName) {
        config = cred.config as unknown as WeComPluginConfig
        connectionId = cred.connectionId
        break
      }
    }
  }

  if (!config && credentials.length > 0) {
    config = credentials[0].config as unknown as WeComPluginConfig
    connectionId = credentials[0].connectionId
  }

  if (!config) {
    logger.warn('POST: no matching credentials', { toUserName })
    return new Response('success', { status: 200 })
  }

  if (!config.token || !config.encodingAESKey) {
    logger.warn('POST: credentials missing token/encodingAESKey')
    return new Response('success', { status: 200 })
  }

  const employeeId =
    (config as WeComPluginConfig & { boundEmployeeId?: string }).boundEmployeeId ?? ''

  // Rebuild Request with the read bodyText to avoid body-already-consumed issue
  const newRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  })

  return handleWeComWebhook(newRequest, {
    plugin: wecomPlugin,
    config,
    employeeId,
    connectionId,
  })
}
