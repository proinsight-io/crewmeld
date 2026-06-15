/**
 * Unified webhook processing pipeline — shared by all channels
 *
 * Flow:
 * 1. Parse request body
 * 2. URL verification challenge
 * 3. Decrypt payload (if applicable)
 * 4. Match credentials
 * 5. Signature verification
 * 6. Card callback handling
 * 7. Message parsing
 * 8. Deduplication
 * 9. Find/create channel_session + conversation
 * 10. Invoke conversation engine + SSE consumption + reply
 */

import {
  channelSessions,
  conversations,
  db,
  sopDefinitions,
  sopExecutions,
  sopNodeExecutions,
  sopPauseStates,
} from '@crewmeld/db'
import type { ConversationChannel } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { processMessage } from '@/lib/conversation/engine'
import { type FileAttachment, uploadConversationFile } from '@/lib/conversation/file-storage'
import { t } from '@/lib/core/server-i18n'
import { chunkForChannel } from './chunk'
import { isMessageDuplicate } from './dedup'
import type { CardActionEvent, ChannelPlugin } from './plugin-types'
import { consumeSSEStream } from './sse-consumer'

const logger = createLogger('WebhookHandler')

/**
 * Webhook handler options
 */
export interface WebhookHandlerOptions<TConfig = Record<string, unknown>> {
  /** Channel plugin */
  plugin: ChannelPlugin<TConfig>

  /** Channel config (parsed from DB or env vars) */
  config: TConfig

  /** Digital employee ID */
  employeeId: string

  /** Workspace ID */
  workspaceId?: string

  /** Id of the systemConnections row that received this message. */
  connectionId?: string

  /** Card callback handler (optional, customizable per channel) */
  onCardAction?: (event: CardActionEvent, config: TConfig) => Promise<void>
}

/**
 * Parsed webhook request body result
 */
interface ParsedWebhookBody {
  body: Record<string, unknown>
  bodyText: string
}

/**
 * Parse request body to JSON (generic)
 */
export async function parseRequestBody(request: Request): Promise<ParsedWebhookBody | null> {
  const bodyText = await request.text()
  try {
    const body = JSON.parse(bodyText)
    return { body, bodyText }
  } catch {
    return null
  }
}

/**
 * Unified webhook processing pipeline (JSON request body, for Feishu/DingTalk)
 *
 * For WeCom's XML format, use handleWeComWebhook instead.
 */
export async function handleChannelWebhook<TConfig>(
  request: Request,
  options: WebhookHandlerOptions<TConfig>
): Promise<Response> {
  const { plugin, config, employeeId, workspaceId = 'default', connectionId } = options
  const channelId = plugin.id

  try {
    // 1. Parse request body
    const parsed = await parseRequestBody(request)
    if (!parsed) {
      logger.warn(`${channelId} webhook: JSON parse failed`)
      return Response.json({})
    }

    let { body } = parsed
    const { bodyText } = parsed

    // 2. URL verification challenge
    if (plugin.inbound.handleVerification) {
      const verificationResponse = await plugin.inbound.handleVerification(body, config)
      if (verificationResponse) return verificationResponse
    }

    // 3. Decrypt payload
    if (plugin.inbound.decryptPayload) {
      const decrypted = plugin.inbound.decryptPayload(body, config)
      if (decrypted) {
        body = decrypted

        // After decryption, it might be a challenge
        if (plugin.inbound.handleVerification) {
          const verificationResponse = await plugin.inbound.handleVerification(body, config)
          if (verificationResponse) return verificationResponse
        }
      }
    }

    // 4. Signature verification
    const isValid = await plugin.inbound.verifySignature(request, bodyText, config)
    if (!isValid) {
      logger.warn(`${channelId} signature verification failed`)
      return Response.json({ error: t('signatureVerifyFailed') }, { status: 403 })
    }

    // 5. Card callback handling
    if (plugin.inbound.parseCardAction) {
      const cardAction = plugin.inbound.parseCardAction(body, config)
      if (cardAction) {
        if (options.onCardAction) {
          await options.onCardAction(cardAction, config)
          return Response.json({})
        }
        // Default handling: return updated card, Feishu will immediately replace the original card UI
        const updatedCard = await handleDefaultCardAction(cardAction, plugin, config)
        if (updatedCard) {
          return Response.json({
            toast: {
              type: 'success',
              content: cardAction.action === 'approved' ? t('approvedShort') : t('rejectedShort'),
            },
            card: updatedCard,
          })
        }
        return Response.json({})
      }
    }

    // 6. Message parsing
    const message = plugin.inbound.parseMessage(body, config)
    if (!message) {
      logger.warn(`${channelId} message parse returned null (non-text or condition not met)`, {
        bodyKeys: Object.keys(body).join(','),
      })
      return Response.json({})
    }
    logger.info(`${channelId} message parsed successfully`, {
      messageId: message.messageId,
      userId: message.externalUserId,
      sessionId: message.externalSessionId,
      contentLength: message.content.length,
      contentPreview: message.content.slice(0, 100),
      senderName: message.senderName,
    })

    // 6.1 Telegram /start and /myid commands: reply with user ID for contact info
    if (channelId === 'telegram') {
      const trimmed = message.content.trim()
      if (trimmed === '/start' || trimmed === '/myid') {
        const userId = message.externalUserId
        const name = message.senderName ?? ''
        const replyText = [
          `👋 ${name ? `${t('tgHello')}, ${name}!` : `${t('tgHello')}!`}`,
          '',
          t('tgGreeting'),
          `\`${userId}\``,
          '',
          t('tgInstruction'),
        ].join('\n')
        // Async reply, non-blocking
        plugin.outbound
          .sendText(
            {
              receiveId: message.externalSessionId ?? userId,
              receiveIdType: 'chat_id',
              content: replyText,
            } as unknown as import('@/lib/channels/plugin-types').SendTextParams,
            config
          )
          .catch((err) => {
            logger.warn('Telegram /start reply failed', { error: err })
          })
        // /start does not enter conversation engine, return directly
        if (trimmed === '/start') {
          return Response.json({})
        }
        // /myid also returns directly
        return Response.json({})
      }
    }

    // 7. Deduplication
    const isDuplicate = await isMessageDuplicate(channelId, message.messageId)
    if (isDuplicate) return Response.json({})

    if (!employeeId) {
      logger.warn(`${channelId} channel not bound to digital employee`)
      return Response.json({})
    }

    // 8. Find or create session
    const { conversationId, isNew } = await findOrCreateSession(
      channelId,
      message.externalUserId,
      message.externalSessionId,
      employeeId,
      workspaceId
    )
    logger.info(`${channelId} session ready`, { conversationId, employeeId })

    // 8.1 Ensure conversation metadata has senderName (fetch for new, backfill for existing)
    if (channelId === 'telegram') {
      // Telegram messages include sender name, persist directly
      if (message.senderName) {
        await persistSenderName(conversationId, message.senderName)
      }
    } else if (
      channelId === 'feishu' ||
      channelId === 'dingtalk' ||
      channelId === 'wecom' ||
      channelId === 'discord'
    ) {
      await ensureSenderName(
        conversationId,
        message.externalUserId,
        config as Record<string, unknown>,
        message.externalSessionId
      )
    }

    // 8.2 Resolve and log the sender's org directory detail (positions /
    // employeeNo / department / leader) using this bound connection's creds.
    logSenderIdentity(
      channelId,
      message.externalUserId,
      conversationId,
      config as Record<string, unknown>
    )

    // 9. Process message
    if (plugin.outbound.deliveryMode === 'response') {
      // DingTalk mode: synchronously wait for result, return response body
      return await handleSyncResponse(conversationId, message, plugin, config, connectionId)
    }

    // Async mode: return 200 immediately, process in background
    logger.info(`${channelId} entering async processing mode`, { conversationId, employeeId })
    handleAsyncResponse(conversationId, message, plugin, config, connectionId).catch((error) => {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.error(`${channelId} async message processing failed`, {
        conversationId,
        error: errMsg,
        stack: error instanceof Error ? error.stack : undefined,
      })
    })

    return Response.json({})
  } catch (error) {
    logger.error(`${channelId} webhook error`, error)
    return Response.json({})
  }
}

/**
 * WeCom-specific webhook processing pipeline (XML request body)
 */
export async function handleWeComWebhook<TConfig>(
  request: Request,
  options: WebhookHandlerOptions<TConfig>
): Promise<Response> {
  const { plugin, config, employeeId, workspaceId = 'default', connectionId } = options
  const channelId = plugin.id

  try {
    const bodyText = await request.text()

    // Signature verification (WeCom: signature in query string, content in XML body)
    const isValid = await plugin.inbound.verifySignature(request, bodyText, config)
    if (!isValid) {
      logger.warn(`${channelId} signature verification failed`)
      return Response.json({ error: t('signatureVerifyFailed') }, { status: 403 })
    }

    // Put raw XML into body object for plugin parsing
    const body: Record<string, unknown> = { __rawXml: bodyText }

    // Card callback handling
    if (plugin.inbound.parseCardAction) {
      const cardAction = plugin.inbound.parseCardAction(body, config)
      if (cardAction) {
        if (options.onCardAction) {
          await options.onCardAction(cardAction, config)
          return new Response('success', { status: 200 })
        }
        // WeCom uses handleDefaultCardAction, card updated via update_template_card API (not via response body)
        // Must await tryUpdateCardToDone completion before returning
        await handleDefaultCardAction(cardAction, plugin, config)
        return new Response('success', { status: 200 })
      }
    }

    // Message parsing
    const message = plugin.inbound.parseMessage(body, config)
    if (!message) return new Response('success', { status: 200 })

    // Deduplication
    const isDuplicate = await isMessageDuplicate(channelId, message.messageId)
    if (isDuplicate) return new Response('success', { status: 200 })

    if (!employeeId) {
      logger.warn(`${channelId} channel not bound to digital employee`)
      return new Response('success', { status: 200 })
    }

    // Find or create session
    const { conversationId } = await findOrCreateSession(
      channelId,
      message.externalUserId,
      message.externalSessionId,
      employeeId,
      workspaceId
    )

    // Ensure senderName (for Official Account/WeCom and other XML channels)
    await ensureSenderName(
      conversationId,
      message.externalUserId,
      config as Record<string, unknown>,
      message.externalSessionId
    )

    // Resolve + log the sender's org identity (same as the JSON-webhook path)
    logSenderIdentity(
      channelId,
      message.externalUserId,
      conversationId,
      config as Record<string, unknown>
    )

    // Async processing
    handleAsyncResponse(conversationId, message, plugin, config, connectionId).catch((error) => {
      logger.error(`${channelId} message processing failed`, error)
    })

    return new Response('success', { status: 200 })
  } catch (error) {
    logger.error(`${channelId} webhook error`, error)
    return new Response('success', { status: 200 })
  }
}

/**
 * Find or create channel_session + conversation
 */
export async function findOrCreateSession(
  channel: ConversationChannel,
  externalUserId: string,
  externalSessionId: string | undefined,
  employeeId: string,
  workspaceId: string
): Promise<{ conversationId: string; isNew: boolean }> {
  const [existingSession] = await db
    .select({ conversationId: channelSessions.conversationId })
    .from(channelSessions)
    .where(
      and(
        eq(channelSessions.channel, channel),
        eq(channelSessions.externalUserId, externalUserId),
        eq(channelSessions.employeeId, employeeId)
      )
    )
    .limit(1)

  if (existingSession) {
    // Discord etc.: user may have switched channels, update externalSessionId to current channel
    if (externalSessionId && channel === 'discord') {
      await db
        .update(channelSessions)
        .set({ externalSessionId, updatedAt: new Date() })
        .where(
          and(
            eq(channelSessions.channel, channel),
            eq(channelSessions.externalUserId, externalUserId),
            eq(channelSessions.employeeId, employeeId)
          )
        )
    }
    return { conversationId: existingSession.conversationId, isNew: false }
  }

  const conversationId = uuidv4()
  await db.insert(conversations).values({
    id: conversationId,
    employeeId,
    userId: externalUserId,
    workspaceId,
    channel,
  })
  await db.insert(channelSessions).values({
    id: uuidv4(),
    channel,
    externalUserId,
    externalSessionId,
    conversationId,
    employeeId,
  })

  return { conversationId, isNew: true }
}

/**
 * Persist senderName directly to conversation metadata (for channels like Telegram that already have the name)
 */
async function persistSenderName(conversationId: string, senderName: string): Promise<void> {
  try {
    const [conv] = await db
      .select({ metadata: conversations.metadata })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)

    const existing = (conv?.metadata ?? {}) as Record<string, unknown>
    if (existing.senderName) return

    await db
      .update(conversations)
      .set({ metadata: { ...existing, senderName } })
      .where(eq(conversations.id, conversationId))

    logger.info('Sender name persisted', { conversationId, senderName })
  } catch (error) {
    logger.warn('Failed to persist sender name (non-blocking)', { conversationId, error })
  }
}

/**
 * Resolve and log the sender's org directory detail (positions / employeeNo /
 * department / leader) for the IM channels that expose it.
 *
 * Uses the credentials of the connection that actually received the message
 * (the webhook `config`), not the system-default connection — so it reflects
 * what this bound bot can read and never breaks when a different connection is
 * the system default. Fire-and-forget and non-blocking.
 */
function logSenderIdentity(
  channelId: string,
  userId: string,
  conversationId: string,
  config: Record<string, unknown>
): void {
  const fetchDetail = async () => {
    if (channelId === 'feishu' && config.appId && config.appSecret) {
      const { getFeishuUserDetail } = await import('./feishu-client')
      return getFeishuUserDetail(config.appId as string, config.appSecret as string, userId)
    }
    if (channelId === 'dingtalk' && config.appKey && config.appSecret) {
      const { getDingtalkUserDetail } = await import('./dingtalk-client')
      return getDingtalkUserDetail(config.appKey as string, config.appSecret as string, userId)
    }
    if (channelId === 'wecom' && config.corpId && config.corpSecret) {
      const { getWecomUserDetail } = await import('./wecom/directory')
      return getWecomUserDetail(config.corpId as string, config.corpSecret as string, userId)
    }
    return null
  }

  void fetchDetail()
    .then((detail) => {
      logger.info('Sender org identity', { conversationId, channel: channelId, userId, detail })
    })
    .catch((error) => {
      logger.warn('Sender identity resolve failed (non-blocking)', {
        conversationId,
        channel: channelId,
        error,
      })
    })
}

/**
 * Ensure conversation metadata has senderName
 *
 * Skips if senderName already exists (idempotent), silently ignores failures without blocking the main flow.
 */
async function ensureSenderName(
  conversationId: string,
  openId: string,
  config: Record<string, unknown>,
  chatId?: string
): Promise<void> {
  try {
    const [conv] = await db
      .select({ metadata: conversations.metadata })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)

    const existing = (conv?.metadata ?? {}) as Record<string, unknown>

    // Already has senderName, skip
    if (existing.senderName) return

    let name: string | null = null

    // Official Account: WeChat privacy policy restricts cgi-bin/user/info from returning nicknames
    // Use last 5 chars of openId as display name
    const isWxoa = !!(
      config.appId &&
      config.appSecret &&
      config.token &&
      !config.corpId &&
      !config.appKey &&
      !config.botToken
    )
    if (isWxoa) {
      name = `${t('wxoaUserPrefix')} ${openId.slice(-5)}`
    }

    // Discord: fetch user info via REST API
    const botToken = config.botToken as string
    if (!name && botToken) {
      try {
        const { discordFetch } = await import('./plugins/discord/fetch')
        const res = await discordFetch(`/users/${openId}`, botToken)
        if (res.ok) {
          const userData = res.json<Record<string, string>>()
          name = userData.global_name || userData.username || null
        }
      } catch {
        // Discord username fetch failed, non-blocking
      }
    }

    // Feishu: fetch via Contacts API / Chat Members API
    const appId = config.appId as string
    const appSecret = config.appSecret as string
    if (!name && appId && appSecret) {
      const { getFeishuUserName } = await import('./feishu-client')
      name = await getFeishuUserName(appId, appSecret, openId, chatId)
    }

    // DingTalk: fetch via User Detail API
    const appKey = config.appKey as string
    const appSecretDt = config.appSecret as string
    if (!name && appKey && appSecretDt) {
      const { getDingtalkUserName } = await import('./dingtalk-client')
      name = await getDingtalkUserName(appKey, appSecretDt, openId)
    }

    // WeCom: fetch via Directory API
    const corpId = config.corpId as string
    const corpSecret = config.corpSecret as string
    if (!name && corpId && corpSecret) {
      try {
        const { callWeComApiWithRetry } = await import('@/lib/channels/wecom/auth')
        const result = await callWeComApiWithRetry<{ errcode: number; name?: string }>(
          corpId,
          corpSecret,
          async (accessToken) => {
            const res = await fetch(
              `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${accessToken}&userid=${openId}`
            )
            return res.json()
          }
        )
        if (result.errcode === 0 && result.name) {
          name = result.name
        }
      } catch {
        // WeCom username fetch failed, non-blocking
      }
    }

    if (!name) return

    await db
      .update(conversations)
      .set({ metadata: { ...existing, senderName: name } })
      .where(eq(conversations.id, conversationId))

    logger.info('Sender name persisted', { conversationId, senderName: name })
  } catch (error) {
    logger.warn('Failed to get sender name (non-blocking)', { conversationId, error })
  }
}

/** MIME type inference */
function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    json: 'application/json',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    xml: 'application/xml',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Download channel file → store in MinIO (no content parsing; files are processed by SOP tools)
 */
async function downloadAndStoreFile(
  message: Record<string, unknown>,
  conversationId: string
): Promise<FileAttachment | null> {
  const pendingFile = message._pendingFile as
    | {
        fileName: string
        fileKey?: string
        msgId?: string
        appId?: string
        appSecret?: string
        downloadCode?: string
        robotCode?: string
        appKey?: string
        mediaId?: string
        corpId?: string
        corpSecret?: string
        url?: string
        fileId?: string
        botToken?: string
      }
    | undefined

  if (!pendingFile) return null

  try {
    let buffer: Buffer

    if (pendingFile.downloadCode && pendingFile.appKey && pendingFile.appSecret) {
      const { downloadRobotFile } = await import('./dingtalk-client')
      buffer = await downloadRobotFile(
        pendingFile.appKey,
        pendingFile.appSecret,
        pendingFile.downloadCode,
        pendingFile.robotCode ?? pendingFile.appKey
      )
    } else if (
      pendingFile.fileKey &&
      pendingFile.appId &&
      pendingFile.appSecret &&
      pendingFile.msgId
    ) {
      const { downloadMessageFile } = await import('./feishu-client')
      buffer = await downloadMessageFile(
        pendingFile.appId,
        pendingFile.appSecret,
        pendingFile.msgId,
        pendingFile.fileKey
      )
    } else if (pendingFile.mediaId && pendingFile.corpId && pendingFile.corpSecret) {
      const { callWeComApiWithRetry } = await import('@/lib/channels/wecom/auth')
      buffer = await callWeComApiWithRetry<Buffer>(
        pendingFile.corpId,
        pendingFile.corpSecret,
        async (accessToken) => {
          const res = await fetch(
            `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${pendingFile.mediaId}`
          )
          if (!res.ok) throw new Error(`${t('channelWecomFileDownloadFailed')}: HTTP ${res.status}`)
          return Buffer.from(await res.arrayBuffer()) as unknown as Buffer & {
            errcode: number
            errmsg: string
          }
        }
      )
    } else if (pendingFile.fileId && pendingFile.botToken) {
      // Telegram: get file_path via getFile API, then download file
      const { proxyFetch } = await import('./proxy-fetch')
      const apiBase = `https://api.telegram.org/bot${pendingFile.botToken}`
      const getFileRes = await proxyFetch(`${apiBase}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: pendingFile.fileId }),
      })
      if (!getFileRes.ok) throw new Error(`Telegram getFile failed: HTTP ${getFileRes.status}`)
      const getFileData = (await getFileRes.json()) as {
        ok: boolean
        result?: { file_path?: string }
      }
      if (!getFileData.ok || !getFileData.result?.file_path)
        throw new Error(`Telegram getFile ${t('channelFileDownloadBadResponse')}`)
      const fileUrl = `https://api.telegram.org/file/bot${pendingFile.botToken}/${getFileData.result.file_path}`
      const dlRes = await proxyFetch(fileUrl)
      if (!dlRes.ok)
        throw new Error(`Telegram ${t('channelFileDownloadFailed')}: HTTP ${dlRes.status}`)
      buffer = Buffer.from(await dlRes.arrayBuffer())
    } else if (pendingFile.url) {
      // Discord etc.: download attachments directly via URL (supports HTTPS_PROXY)
      const proxy = process.env.HTTPS_PROXY
      if (proxy) {
        const { proxyDownload } = await import('./plugins/discord/download')
        buffer = await proxyDownload(pendingFile.url, proxy)
      } else {
        const res = await fetch(pendingFile.url)
        if (!res.ok) throw new Error(`${t('channelFileDownloadFailed')}: HTTP ${res.status}`)
        buffer = Buffer.from(await res.arrayBuffer())
      }
    } else {
      return null
    }

    // Upload to MinIO
    const mimeType = guessMimeType(pendingFile.fileName)
    const fileAttachment = await uploadConversationFile(
      conversationId,
      pendingFile.fileName,
      buffer,
      mimeType
    )

    return fileAttachment
  } catch (error) {
    logger.error('Channel file download/storage failed', { fileName: pendingFile.fileName, error })
    return null
  }
}

/**
 * Process message asynchronously (Feishu/WeCom mode)
 */
async function handleAsyncResponse<TConfig>(
  conversationId: string,
  message: {
    externalUserId: string
    content: string
    externalSessionId?: string
    rawPayload: Record<string, unknown>
    messageType?: string
  },
  plugin: ChannelPlugin<TConfig>,
  config: TConfig,
  connectionId?: string
): Promise<void> {
  const channelId = plugin.id
  // Pre-compute receiver info (needed for both replies and error messages)
  const { finalReceiveId, finalReceiveIdType } = resolveReceiver(message, plugin)
  // DingTalk sessionWebhook: reply URL provided by robot callback
  const sessionWebhook = message.rawPayload.sessionWebhook as string | undefined

  logger.info(`[${channelId}] Starting async message processing`, {
    conversationId,
    userId: message.externalUserId,
    receiveId: finalReceiveId,
    receiveIdType: finalReceiveIdType,
    contentLength: message.content.length,
    messageType: message.messageType ?? 'text',
  })

  // If file message, download and store in MinIO (no content parsing)
  const finalContent = message.content
  let fileMetadata: FileAttachment[] | undefined

  if (message.messageType === 'file') {
    logger.info(`[${channelId}] File message detected, starting download`, { conversationId })
    const fileAttachment = await downloadAndStoreFile(
      message as Record<string, unknown>,
      conversationId
    )
    if (fileAttachment) {
      fileMetadata = [fileAttachment]
      // Pure file message (no user text): leave content empty, engine will prompt user for intent
    }
    logger.info(`[${channelId}] File processing completed`, {
      conversationId,
      hasFileAttachment: !!fileAttachment,
    })
  }

  let result: import('./sse-consumer').ConsumeResult
  try {
    logger.info(`[${channelId}] Calling processMessage`, {
      conversationId,
      contentLength: finalContent.length,
    })
    const stream = await processMessage(
      conversationId,
      finalContent,
      message.externalUserId,
      fileMetadata,
      undefined,
      config as Record<string, unknown>,
      connectionId
    )
    logger.info(`[${channelId}] processMessage returned stream, consuming SSE`, { conversationId })

    // Progress dedup: skip identical progress messages
    let lastProgressMsg = ''

    result = await consumeSSEStream(stream, {
      onProgress: (msg) => {
        if (msg === lastProgressMsg) return
        lastProgressMsg = msg
        // Official Account customer service messages have a 5 msg/48h limit, skip intermediate progress, send only final result
        if (channelId === 'wxoa') {
          logger.info(
            `[${channelId}] Skipping progress notification (saving customer service message quota)`,
            { conversationId, progress: msg.slice(0, 100) }
          )
          return
        }
        logger.info(`[${channelId}] Sending progress notification`, {
          conversationId,
          progress: msg.slice(0, 100),
        })
        // Send progress asynchronously, don't block stream consumption
        plugin.outbound
          .sendText(
            {
              receiveId: finalReceiveId,
              receiveIdType: finalReceiveIdType,
              content: msg,
              sessionWebhook,
            } as unknown as import('@/lib/channels/plugin-types').SendTextParams,
            config
          )
          .catch((err) => {
            logger.warn(`[${channelId}] Progress message send failed`, { error: err })
          })
      },
    })

    logger.info(`[${channelId}] SSE consumption completed`, {
      conversationId,
      contentLength: result.content.length,
      filesCount: result.files.length,
      contentPreview: result.content.slice(0, 200),
    })
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[${channelId}] Message processing error`, { conversationId, error: errMsg })

    // On failure, also send error message to user to avoid "no response"
    await plugin.outbound
      .sendText(
        {
          receiveId: finalReceiveId,
          receiveIdType: finalReceiveIdType,
          content: `${t('processError')}: ${errMsg}`,
          sessionWebhook,
        } as unknown as import('@/lib/channels/plugin-types').SendTextParams,
        config
      )
      .catch((sendErr) => {
        logger.error(`[${channelId}] Error message send failed`, sendErr)
      })
    return
  }

  // Send text reply (chunked per channel limits)
  if (result.content) {
    const channel = channelId as import('@crewmeld/db/schema').ConversationChannel
    const chunks = chunkForChannel(result.content, channel)
    logger.info(`[${channelId}] Preparing to send text reply`, {
      conversationId,
      receiveId: finalReceiveId,
      totalLength: result.content.length,
      chunkCount: chunks.length,
    })

    for (let i = 0; i < chunks.length; i++) {
      try {
        logger.info(`[${channelId}] Sending chunk ${i + 1}/${chunks.length}`, {
          conversationId,
          chunkLength: chunks[i].length,
          chunkPreview: chunks[i].slice(0, 100),
        })
        await plugin.outbound.sendText(
          {
            receiveId: finalReceiveId,
            receiveIdType: finalReceiveIdType,
            content: chunks[i],
            sessionWebhook,
          } as unknown as import('@/lib/channels/plugin-types').SendTextParams,
          config
        )
        logger.info(`[${channelId}] Chunk ${i + 1}/${chunks.length} sent successfully`, {
          conversationId,
        })
      } catch (chunkErr) {
        const errMsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
        logger.error(`[${channelId}] Chunk ${i + 1}/${chunks.length} send failed`, {
          conversationId,
          receiveId: finalReceiveId,
          chunkLength: chunks[i].length,
          error: errMsg,
        })
      }
    }
  } else if (result.files.length === 0) {
    logger.warn(`[${channelId}] Reply skipped: content and attachments are both empty`, {
      conversationId,
    })
    return
  }

  // Send attachments
  if (result.files.length > 0 && plugin.outbound.sendFile) {
    for (const file of result.files) {
      try {
        logger.info(`[${channelId}] Sending attachment`, {
          conversationId,
          receiveId: finalReceiveId,
          fileName: file.name,
        })
        await plugin.outbound.sendFile(
          { receiveId: finalReceiveId, receiveIdType: finalReceiveIdType, file },
          config
        )
        logger.info(`[${channelId}] Attachment sent successfully`, {
          conversationId,
          receiveId: finalReceiveId,
          fileName: file.name,
        })
      } catch (fileErr) {
        logger.error(`[${channelId}] Attachment send failed`, {
          conversationId,
          fileName: file.name,
          error: fileErr,
        })
      }
    }
  }

  logger.info(`[${channelId}] Async message processing completed`, { conversationId })
}

/**
 * Resolve message receiver (Feishu group vs direct, WeCom, etc.)
 */
function resolveReceiver<TConfig>(
  message: {
    externalUserId: string
    externalSessionId?: string
    rawPayload: Record<string, unknown>
  },
  plugin: ChannelPlugin<TConfig>
): { finalReceiveId: string; finalReceiveIdType: string } {
  if (plugin.id === 'feishu') {
    const event = message.rawPayload.event as Record<string, unknown> | undefined
    const msg = event?.message as Record<string, unknown> | undefined
    const chatType = msg?.chat_type as string | undefined
    const chatId = msg?.chat_id as string | undefined
    if (chatType === 'group' && chatId) {
      return { finalReceiveId: chatId, finalReceiveIdType: 'chat_id' }
    }
    // externalUserId stores user_id (consistent within org), but Feishu send message API requires open_id
    const sender = event?.sender as Record<string, unknown> | undefined
    const senderIdObj = sender?.sender_id as Record<string, string> | undefined
    const openId = senderIdObj?.open_id ?? message.externalUserId
    return { finalReceiveId: openId, finalReceiveIdType: 'open_id' }
  }

  if (plugin.id === 'dingtalk') {
    // DingTalk group message's conversationId is openConversationId
    const conversationType = message.rawPayload.conversationType as string | undefined
    const conversationId = message.rawPayload.conversationId as string | undefined
    if (conversationType === '2' && conversationId) {
      return { finalReceiveId: conversationId, finalReceiveIdType: 'chat_id' }
    }
    return { finalReceiveId: message.externalUserId, finalReceiveIdType: 'user_id' }
  }

  // Discord: reply to the channel where the message originated
  if (plugin.id === 'discord') {
    const channelId = message.rawPayload.channel_id as string | undefined
    if (channelId) {
      return { finalReceiveId: channelId, finalReceiveIdType: 'channel_id' }
    }
  }

  if (plugin.id === 'telegram') {
    // Telegram DM and group should both reply to chat.id (externalSessionId)
    // In DM: chat.id === from.id; in group: chat.id is the group ID
    if (message.externalSessionId) {
      return { finalReceiveId: message.externalSessionId, finalReceiveIdType: 'chat_id' }
    }
    return { finalReceiveId: message.externalUserId, finalReceiveIdType: 'chat_id' }
  }

  // WeCom and other channels
  return { finalReceiveId: message.externalUserId, finalReceiveIdType: 'open_id' }
}

/**
 * Process message synchronously (DingTalk mode — return response body)
 */
async function handleSyncResponse<TConfig>(
  conversationId: string,
  message: { externalUserId: string; content: string },
  plugin: ChannelPlugin<TConfig>,
  config: TConfig,
  connectionId?: string
): Promise<Response> {
  try {
    const stream = await processMessage(
      conversationId,
      message.content,
      message.externalUserId,
      undefined,
      undefined,
      config as Record<string, unknown>,
      connectionId
    )
    const result = await consumeSSEStream(stream)

    if (result.content) {
      return Response.json({
        msgtype: 'markdown',
        markdown: {
          title: t('replyTitle'),
          text: result.content,
        },
      })
    }
  } catch (error) {
    logger.error(`${plugin.id} message processing failed`, error)
  }

  return Response.json({ msgtype: 'empty', empty: {} })
}

/**
 * Query approval context info (SOP name, node name, previous step result, initiator)
 */
async function queryApprovalContext(
  executionId: string,
  nodeId: string
): Promise<{
  sopName: string
  nodeName: string
  previousResult?: string
  senderName?: string
  userLanguage?: string
}> {
  const fallback = { sopName: '', nodeName: '' }

  try {
    // Query SOP name
    const [execRow] = await db
      .select({
        sopDefinitionId: sopExecutions.sopDefinitionId,
        triggeredBy: sopExecutions.triggeredBy,
        triggerData: sopExecutions.triggerData,
      })
      .from(sopExecutions)
      .where(eq(sopExecutions.id, executionId))
      .limit(1)

    if (!execRow) return fallback

    const [defRow] = await db
      .select({ name: sopDefinitions.name })
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, execRow.sopDefinitionId!))
      .limit(1)

    // Query current node name
    const [nodeRow] = await db
      .select({ nodeName: sopNodeExecutions.nodeName })
      .from(sopNodeExecutions)
      .where(
        and(eq(sopNodeExecutions.executionId, executionId), eq(sopNodeExecutions.nodeId, nodeId))
      )
      .limit(1)

    // Query previous node result (latest completed record before current node, ordered by completion time)
    let previousResult: string | undefined
    const prevNodes = await db
      .select({ result: sopNodeExecutions.result })
      .from(sopNodeExecutions)
      .where(
        and(
          eq(sopNodeExecutions.executionId, executionId),
          eq(sopNodeExecutions.status, 'completed')
        )
      )
      .orderBy(sopNodeExecutions.completedAt)
      .limit(1)

    if (prevNodes.length > 0 && prevNodes[0].result) {
      previousResult =
        typeof prevNodes[0].result === 'string'
          ? prevNodes[0].result
          : JSON.stringify(prevNodes[0].result)
    }

    // Extract initiator name and user language from triggerData._meta
    const triggerData = execRow.triggerData as Record<string, unknown> | null
    const meta = triggerData?._meta as Record<string, unknown> | undefined
    const senderName =
      (meta?.senderName as string) ?? (triggerData?.senderName as string) ?? undefined
    const userLanguage = (meta?.userLanguage as string) ?? undefined

    return {
      sopName: defRow?.name ?? '',
      nodeName: nodeRow?.nodeName ?? '',
      previousResult,
      senderName,
      userLanguage,
    }
  } catch (error) {
    logger.warn('Failed to query approval context', { executionId, nodeId, error })
    return fallback
  }
}

/**
 * Default card callback handler (SOP approval)
 *
 * Card buttons pass pauseId (sopPauseStates table primary key);
 * need to query corresponding executionId and nodeId before calling resumeSopFromPause.
 */
async function handleDefaultCardAction<TConfig>(
  cardAction: CardActionEvent,
  plugin: ChannelPlugin<TConfig>,
  config: TConfig
): Promise<Record<string, unknown> | null> {
  const { action, pauseId, operatorId } = cardAction
  if (action !== 'approved' && action !== 'rejected') return null

  try {
    // First-Wins atomic CAS: only update to 'decided' when status='waiting'
    // Duplicate clicks affect 0 rows → return directly
    const decidedAt = new Date()
    const updatedRows = await db
      .update(sopPauseStates)
      .set({
        status: 'decided',
        decision: action,
        decidedBy: operatorId,
        decidedAt,
      })
      .where(and(eq(sopPauseStates.id, pauseId), eq(sopPauseStates.status, 'waiting')))
      .returning({
        executionId: sopPauseStates.executionId,
        nodeId: sopPauseStates.nodeId,
      })

    if (updatedRows.length === 0) {
      logger.warn(
        `${plugin.id} approval callback: already processed or not found, attempting to update current channel card`,
        { pauseId, action }
      )

      // Query existing approval result, build complete done card and update current channel
      const [existingPause] = await db
        .select({
          executionId: sopPauseStates.executionId,
          nodeId: sopPauseStates.nodeId,
          decision: sopPauseStates.decision,
          decidedBy: sopPauseStates.decidedBy,
          decidedAt: sopPauseStates.decidedAt,
        })
        .from(sopPauseStates)
        .where(eq(sopPauseStates.id, pauseId))
        .limit(1)

      if (existingPause?.executionId) {
        const ctx = await queryApprovalContext(existingPause.executionId, existingPause.nodeId)
        const actualDecision = existingPause.decision ?? action
        const actualDecidedBy = existingPause.decidedBy ?? operatorId
        const actualDecidedAt = existingPause.decidedAt ?? decidedAt

        // Update the current channel's card to processed state via API
        await tryUpdateCardToDone(
          plugin,
          cardAction,
          {
            sopName: ctx.sopName,
            nodeName: ctx.nodeName,
            decision: actualDecision,
            decidedBy: actualDecidedBy,
            senderName: ctx.senderName,
            previousResult: ctx.previousResult,
            decidedAt: actualDecidedAt,
            userLanguage: ctx.userLanguage,
          },
          config
        )

        return buildDoneCardIfPossible(plugin, {
          sopName: ctx.sopName,
          nodeName: ctx.nodeName,
          decision: actualDecision,
          decidedBy: actualDecidedBy,
          senderName: ctx.senderName,
          previousResult: ctx.previousResult,
          decidedAt: actualDecidedAt,
          userLanguage: ctx.userLanguage,
        })
      }

      return buildDoneCardIfPossible(plugin, {
        sopName: '',
        nodeName: '',
        decision: action,
        decidedBy: operatorId,
        decidedAt,
      })
    }

    const pauseRow = updatedRows[0]

    // Query approval context (SOP name, node name, previous result, initiator)
    const ctx = await queryApprovalContext(pauseRow.executionId, pauseRow.nodeId)

    // Build done card (returned via callback response to Feishu for instant UI update)
    const doneCard = buildDoneCardIfPossible(plugin, {
      sopName: ctx.sopName,
      nodeName: ctx.nodeName,
      decision: action,
      decidedBy: operatorId,
      senderName: ctx.senderName,
      previousResult: ctx.previousResult,
      decidedAt,
      userLanguage: ctx.userLanguage,
    })

    // Also update card via PATCH API (fallback, ensuring non-callback scenarios are also updated)
    await tryUpdateCardToDone(
      plugin,
      cardAction,
      {
        sopName: ctx.sopName,
        nodeName: ctx.nodeName,
        decision: action,
        decidedBy: operatorId,
        senderName: ctx.senderName,
        previousResult: ctx.previousResult,
        decidedAt,
        userLanguage: ctx.userLanguage,
      },
      config
    )

    const { resumeSopFromPause } = await import('@/lib/sop/engine')

    await resumeSopFromPause({
      executionId: pauseRow.executionId,
      nodeId: pauseRow.nodeId,
      decision: action,
      decidedBy: operatorId,
    })

    logger.info(`${plugin.id} approval callback processed successfully`, {
      pauseId,
      decision: action,
      decidedBy: operatorId,
    })
    return doneCard
  } catch (error) {
    logger.error(`${plugin.id} approval callback processing failed`, { pauseId, error })
    return null
  }
}

/**
 * Build processed approval card (pure construction, no API calls)
 */
function buildDoneCardIfPossible<TConfig>(
  plugin: ChannelPlugin<TConfig>,
  params: {
    sopName: string
    nodeName: string
    decision: string
    decidedBy: string
    senderName?: string
    previousResult?: string
    decidedAt?: Date
    userLanguage?: string
  }
): Record<string, unknown> | null {
  if (!plugin.buildApprovalDoneCard) return null
  return plugin.buildApprovalDoneCard({
    sopName: params.sopName,
    nodeName: params.nodeName,
    decision: params.decision as 'approved' | 'rejected',
    decidedBy: params.decidedBy,
    senderName: params.senderName,
    previousResult: params.previousResult,
    decidedAt: params.decidedAt,
    language: params.userLanguage,
  })
}

/**
 * Attempt to update card to processed state (does not throw)
 */
async function tryUpdateCardToDone<TConfig>(
  plugin: ChannelPlugin<TConfig>,
  cardAction: CardActionEvent,
  params: {
    sopName: string
    nodeName: string
    decision: string
    decidedBy: string
    senderName?: string
    previousResult?: string
    decidedAt?: Date
    userLanguage?: string
  },
  config: TConfig
): Promise<void> {
  if (!plugin.buildApprovalDoneCard || !plugin.outbound.updateCard) return

  const messageId = cardAction.messageId ?? cardAction.taskId

  logger.info('tryUpdateCardToDone', {
    pluginId: plugin.id,
    messageId: messageId?.slice(0, 20),
    messageIdLen: messageId?.length,
    hasMessageId: !!cardAction.messageId,
    taskId: cardAction.taskId?.slice(0, 20),
    taskIdLen: cardAction.taskId?.length,
  })

  if (!messageId) return

  try {
    const doneCard = plugin.buildApprovalDoneCard({
      sopName: params.sopName,
      nodeName: params.nodeName,
      decision: params.decision as 'approved' | 'rejected',
      decidedBy: params.decidedBy,
      senderName: params.senderName,
      previousResult: params.previousResult,
      language: params.userLanguage,
      decidedAt: params.decidedAt,
    })
    // Telegram stores chat_id in taskId, other channels use operatorId for toUser
    const toUser =
      plugin.id === 'telegram'
        ? (cardAction.taskId ?? cardAction.operatorId)
        : cardAction.operatorId
    await plugin.outbound.updateCard({ messageId, card: doneCard, toUser }, config)
  } catch (error) {
    logger.warn(`${plugin.id} card update failed (non-blocking for approval flow)`, {
      messageId,
      error,
    })
  }
}
