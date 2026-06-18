/**
 * DingTalk channel plugin - full implementation
 *
 * Delivery mode: direct (async push)
 * Message reply: prefers sessionWebhook (included in robot callback), falls back to Robot API
 * Card support: ActionCard (independent buttons jumping to approval page)
 */

import crypto from 'crypto'
import { t } from '@/lib/core/server-i18n'
import type { ApprovalCardParams, ApprovalDoneCardParams, ChannelPlugin } from '../../plugin-types'
import type { ChannelMessage } from '../../types'
import { CHANNEL_MAX_LENGTH } from '../../types'
import { type DingtalkPluginConfig, dingtalkPluginConfigSchema } from './types'

const TEXT_FILE_EXTENSIONS = new Set([
  'json',
  'csv',
  'txt',
  'md',
  'xml',
  'yaml',
  'yml',
  'log',
  'ini',
  'conf',
  'toml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'py',
  'sql',
  'sh',
  'bat',
  'env',
])

export const dingtalkPlugin: ChannelPlugin<DingtalkPluginConfig> = {
  id: 'dingtalk',
  label: t('channelPluginDingtalk'),
  aliases: ['ding', 'dingtalk-robot'],
  identityRawFields: [
    { path: 'name', label: '姓名' },
    { path: 'email', label: '邮箱' },
    { path: 'mobile', label: '手机' },
    { path: 'job_number', label: '工号' },
    { path: 'title', label: '职务' },
    { path: 'dept_id_list', label: '部门ID列表' },
    { path: 'deptNames', label: '部门名' },
    { path: 'manager_userid', label: '直属主管userid' },
  ],

  capabilities: {
    direct: true,
    channel: true,
    threads: false,
    media: true,
    reactions: false,
    editing: false,
    replies: false,
    cards: true,
    websocket: false,
  },

  configSchema: dingtalkPluginConfigSchema,

  inbound: {
    async verifySignature(request, _bodyText, config) {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(_bodyText)
      } catch {
        /* ignore */
      }

      // Event subscription mode (encrypted messages): signature already verified in handleVerification, pass through
      if (body.encrypt && config.aesKey) {
        return true
      }

      // Robot callback mode: signature in headers
      const timestamp = request.headers.get('timestamp') ?? ''
      const sign = request.headers.get('sign') ?? ''
      if (!sign) return false

      // Try appSecret, token, secret as signing key in order
      const candidates = [config.appSecret, config.token, config.secret].filter(Boolean) as string[]
      for (const key of candidates) {
        const stringToSign = `${timestamp}\n${key}`
        const hmac = crypto.createHmac('sha256', key).update(stringToSign).digest('base64')
        if (hmac === sign) return true
      }

      return false
    },

    async handleVerification(body, config) {
      if (!config.aesKey) return null

      const encrypt = body.encrypt as string | undefined
      if (!encrypt) return null

      try {
        const { decryptDingtalkPayload, buildEncryptedResponse } = await import(
          '../../dingtalk-crypto'
        )
        const plainText = decryptDingtalkPayload(config.aesKey, encrypt)

        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(plainText)
        } catch {
          /* ignore */
        }

        const eventType = parsed.EventType as string | undefined
        if (eventType === 'check_url' || eventType === 'check_create_suite_url') {
          const suiteKey = config.suiteKey ?? config.appKey
          const token = config.token ?? ''
          const responseBody = buildEncryptedResponse(config.aesKey, token, suiteKey, 'success')
          return new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      } catch (error) {
        console.error(t('channelDingtalkDecryptFailed'), error)
      }

      return null
    },

    decryptPayload(body, config) {
      const encrypt = body.encrypt as string | undefined
      if (!encrypt || !config.aesKey) return null

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { decryptDingtalkPayload } =
          require('../../dingtalk-crypto') as typeof import('../../dingtalk-crypto')
        const plainText = decryptDingtalkPayload(config.aesKey, encrypt)
        return JSON.parse(plainText)
      } catch {
        return null
      }
    },

    parseMessage(body, config): ChannelMessage | null {
      const msgType = body.msgtype as string | undefined
      const senderStaffId = (body.senderStaffId ?? body.senderId ?? '') as string
      const msgId = (body.msgId ?? `dingtalk-${Date.now()}`) as string
      const conversationId = body.conversationId as string | undefined
      const robotCode = (body.robotCode as string) || config.robotCode || config.appKey

      console.log('[dingtalk] parseMessage', {
        msgType,
        senderStaffId: senderStaffId || `(${t('channelDingtalkEmpty')})`,
        bodyKeys: Object.keys(body).join(','),
      })

      if (!senderStaffId) return null

      // Text message
      if (msgType === 'text') {
        const text = body.text as Record<string, unknown> | undefined
        const content = (text?.content as string)?.trim()
        if (!content) return null

        return {
          channel: 'dingtalk',
          externalUserId: senderStaffId,
          externalSessionId: conversationId,
          messageId: msgId,
          content,
          messageType: 'text',
          timestamp: (body.createAt as number) ?? Date.now(),
          rawPayload: body,
        }
      }

      // File message: extract downloadCode, downloaded asynchronously by webhook-handler
      // DingTalk file info is in body.content (JSON string)
      if (msgType === 'file') {
        let fileInfo: Record<string, unknown> = {}
        try {
          const raw = body.content as string | Record<string, unknown> | undefined
          fileInfo = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
        } catch {
          /* ignore */
        }
        console.log(`[dingtalk] ${t('channelDingtalkFileMsg')} content`, JSON.stringify(fileInfo))
        const downloadCode = (fileInfo.downloadCode as string) ?? (fileInfo.downloadcode as string)
        const fileName = (fileInfo.fileName as string) ?? (fileInfo.filename as string) ?? 'unknown'

        if (!downloadCode) return null

        // All file types are downloaded and stored to MinIO; text files additionally have content extracted for LLM
        return {
          channel: 'dingtalk',
          externalUserId: senderStaffId,
          externalSessionId: conversationId,
          messageId: msgId,
          content: `[User sent a file: ${fileName}]`,
          messageType: 'file',
          timestamp: (body.createAt as number) ?? Date.now(),
          rawPayload: body,
          _pendingFile: {
            fileName,
            downloadCode,
            robotCode,
            appKey: config.appKey,
            appSecret: config.appSecret,
          },
        } as ChannelMessage & { _pendingFile: Record<string, string> }
      }

      // Other message types: return a hint
      if (msgType) {
        const typeNames: Record<string, string> = {
          richText: 'rich text',
          picture: 'image',
          video: 'video',
          audio: 'audio',
        }
        const typeName = typeNames[msgType] ?? msgType
        return {
          channel: 'dingtalk',
          externalUserId: senderStaffId,
          externalSessionId: conversationId,
          messageId: msgId,
          content: `[User sent a ${typeName} message. Only text and file messages are currently supported. Please send your content as text]`,
          messageType: 'text',
          timestamp: (body.createAt as number) ?? Date.now(),
          rawPayload: body,
        }
      }

      return null
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunkerMode: 'markdown',
    textChunkLimit: CHANNEL_MAX_LENGTH.dingtalk,

    async sendText(params, config) {
      // DingTalk robot Markdown does not support GFM tables and folds single
      // newlines — sanitize once here so both sessionWebhook and Robot API
      // paths receive bullet-list-formatted content.
      const { sanitizeForDingtalk, sendDingtalkChunked } = await import('../../dingtalk-sender')
      const sanitized = sanitizeForDingtalk(params.content)

      // Prefer sessionWebhook (included in robot callback, most reliable, no extra permissions needed)
      const sessionWebhook = (params as unknown as Record<string, unknown>).sessionWebhook as
        | string
        | undefined
      if (sessionWebhook) {
        const { sendWebhookMessage } = await import('../../dingtalk-client')
        const title = sanitized.slice(0, 20).replace(/[#*\n]/g, '') || t('channelDingtalkMsg')
        await sendWebhookMessage(sessionWebhook, 'markdown', { title, text: sanitized })
        return
      }

      // Fallback to Robot API (requires robotCode + permissions)
      if (!config.appKey || !config.appSecret) return
      const robotCode = config.robotCode || config.appKey

      await sendDingtalkChunked(
        config.appKey,
        config.appSecret,
        robotCode,
        params.receiveId,
        params.receiveIdType === 'chat_id' ? params.receiveId : undefined,
        sanitized
      )
    },

    async sendFile(params, config) {
      const robotCode = config.robotCode || config.appKey

      const { sendDingtalkFile } = await import('../../dingtalk-sender')
      await sendDingtalkFile(
        config.appKey,
        config.appSecret,
        robotCode,
        params.receiveId,
        params.receiveIdType === 'chat_id' ? params.receiveId : undefined,
        params.file
      )
    },

    async sendCard(params, config) {
      if (!config.appKey || !config.appSecret) return undefined
      const robotCode = config.robotCode || config.appKey

      const { sendDingtalkActionCard } = await import('../../dingtalk-sender')
      await sendDingtalkActionCard(
        config.appKey,
        config.appSecret,
        robotCode,
        params.receiveId,
        params.receiveIdType === 'chat_id' ? params.receiveId : undefined,
        params.card
      )
      return undefined
    },
  },

  buildApprovalCard(params: ApprovalCardParams): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildApprovalCard } =
      require('../../dingtalk-card-builder') as typeof import('../../dingtalk-card-builder')
    return buildApprovalCard({
      sopName: params.sopName,
      nodeName: params.nodeName,
      previousResult: params.previousResult,
      pauseId: params.pauseId,
      approvalToken: params.approvalToken ?? '',
      senderName: params.senderName,
      approvalPageUrl: params.approvalPageUrl,
      language: params.language,
    })
  },

  buildApprovalDoneCard(params: ApprovalDoneCardParams): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildApprovalDoneCard } =
      require('../../dingtalk-card-builder') as typeof import('../../dingtalk-card-builder')
    return buildApprovalDoneCard({
      sopName: params.sopName,
      nodeName: params.nodeName,
      decision: params.decision,
      decidedBy: params.decidedBy,
      senderName: params.senderName,
      previousResult: params.previousResult,
      decidedAt: params.decidedAt,
    })
  },
}
