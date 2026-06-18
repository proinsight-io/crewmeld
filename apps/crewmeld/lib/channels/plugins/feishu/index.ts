/**
 * Feishu channel plugin - wraps existing feishu-adapter / feishu-sender / feishu-card-builder
 */

import crypto from 'crypto'
import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import type { CardActionEvent, ChannelPlugin } from '../../plugin-types'
import type { ChannelMessage } from '../../types'
import { CHANNEL_MAX_LENGTH } from '../../types'
import { type FeishuPluginConfig, feishuPluginConfigSchema } from './types'

const logger = createLogger('FeishuPlugin')

/** File extensions that support reading text content */
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

/**
 * Feishu Encrypt Key decryption
 */
function decryptFeishuPayload(
  encryptKey: string,
  encryptedContent: string
): Record<string, unknown> {
  const keyBuffer = crypto.createHash('sha256').update(encryptKey).digest()
  const encrypted = Buffer.from(encryptedContent, 'base64')
  const iv = encrypted.subarray(0, 16)
  const ciphertext = encrypted.subarray(16)

  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv)
  let decrypted = decipher.update(ciphertext, undefined, 'utf8')
  decrypted += decipher.final('utf8')
  return JSON.parse(decrypted)
}

export const feishuPlugin: ChannelPlugin<FeishuPluginConfig> = {
  id: 'feishu',
  label: t('channelPluginFeishu'),
  aliases: ['lark', 'bytedance'],
  identityRawFields: [
    { path: 'name', label: '姓名' },
    { path: 'email', label: '邮箱' },
    { path: 'mobile', label: '手机' },
    { path: 'employeeNo', label: '工号' },
    { path: 'employeeType', label: '雇佣类型' },
    { path: 'jobTitle', label: '职务' },
    { path: 'departmentIds', label: '部门open_id' },
    { path: 'departmentNames', label: '部门名' },
    { path: 'departmentCustomIds', label: '部门自定义ID' },
    { path: 'leaderId', label: '直属上级ID' },
  ],

  capabilities: {
    direct: true,
    channel: true,
    threads: false,
    media: true,
    reactions: false,
    editing: false,
    replies: true,
    cards: true,
    websocket: false,
  },

  configSchema: feishuPluginConfigSchema,

  inbound: {
    async verifySignature(_request, bodyText, config) {
      const signature = _request.headers.get('X-Lark-Signature')
      if (!signature) return true // Feishu does not send signature headers in some modes

      if (!config.encodingAESKey) return true

      const timestamp = _request.headers.get('X-Lark-Request-Timestamp') ?? ''
      const nonce = _request.headers.get('X-Lark-Request-Nonce') ?? ''
      const toVerify = `${timestamp}${nonce}${config.encodingAESKey}${bodyText}`
      const hash = crypto.createHash('sha256').update(toVerify).digest('hex')
      return hash === signature
    },

    async handleVerification(body, _config) {
      if (body.type === 'url_verification') {
        return Response.json({ challenge: body.challenge })
      }
      return null
    },

    decryptPayload(body, config) {
      if (body.encrypt && typeof body.encrypt === 'string' && config.encodingAESKey) {
        return decryptFeishuPayload(config.encodingAESKey, body.encrypt as string)
      }
      return null
    },

    parseMessage(body, config): ChannelMessage | null {
      const event = body.event as Record<string, unknown> | undefined
      if (!event) return null

      const header = body.header as Record<string, unknown> | undefined
      const eventType = header?.event_type as string | undefined
      if (eventType !== 'im.message.receive_v1') return null

      const message = event.message as Record<string, unknown> | undefined
      const sender = event.sender as Record<string, unknown> | undefined
      if (!message || !sender) return null

      const msgType = message.message_type as string

      // Extract sender info (shared by text / file)
      const senderId = sender.sender_id as Record<string, string> | undefined
      const openId = senderId?.user_id ?? senderId?.open_id ?? ''
      const msgId = (message.message_id as string) ?? `feishu-${Date.now()}`
      const chatId = message.chat_id as string | undefined

      if (!openId) return null

      // Group messages: check @mention (both text and file need checking)
      const chatType = message.chat_type as string | undefined

      if (msgType === 'text') {
        let content = ''
        try {
          const parsed = JSON.parse(message.content as string)
          content = parsed.text ?? ''
        } catch {
          content = (message.content as string) ?? ''
        }

        if (chatType === 'group') {
          const mentions = (message.mentions ?? []) as Array<Record<string, unknown>>
          if (mentions.length === 0) return null
          content = content.replace(/^@\S+\s*/, '').trim()
        }

        if (!content) return null

        return {
          channel: 'feishu',
          externalUserId: openId,
          externalSessionId: chatId,
          messageId: msgId,
          content: content.trim(),
          messageType: 'text',
          timestamp: Number(message.create_time) || Date.now(),
          rawPayload: body,
        }
      }

      if (msgType === 'file') {
        // Group chat files also need @mention check
        if (chatType === 'group') {
          const mentions = (message.mentions ?? []) as Array<Record<string, unknown>>
          if (mentions.length === 0) return null
        }

        // Parse file info
        let fileName = ''
        let fileKey = ''
        try {
          const parsed = JSON.parse(message.content as string)
          fileName = parsed.file_name ?? ''
          fileKey = parsed.file_key ?? ''
        } catch {
          return null
        }

        if (!fileName || !fileKey) return null

        // All file types are downloaded and stored to MinIO; text files additionally have content extracted for LLM
        return {
          channel: 'feishu',
          externalUserId: openId,
          externalSessionId: chatId,
          messageId: msgId,
          content: `[User sent a file: ${fileName}]`,
          messageType: 'file',
          timestamp: Number(message.create_time) || Date.now(),
          rawPayload: body,
          // fileAttachments will be populated via download in webhook-handler
          _pendingFile: {
            fileName,
            fileKey,
            msgId,
            appId: config.appId,
            appSecret: config.appSecret,
          },
        } as ChannelMessage & { _pendingFile: Record<string, string> }
      }

      // Other message types are not supported yet
      return null
    },

    parseCardAction(body, _config): CardActionEvent | null {
      const header = body.header as Record<string, unknown> | undefined
      const eventType = header?.event_type as string | undefined
      if (eventType !== 'card.action.trigger') return null

      const event = body.event as Record<string, unknown> | undefined
      if (!event) return null

      const action = event.action as Record<string, unknown> | undefined
      if (!action) return null

      const value = action.value as Record<string, string> | undefined
      if (!value?.action || !value?.pauseId) return null

      const decision = value.action
      if (decision !== 'approved' && decision !== 'rejected') return null

      const operator = event.operator as Record<string, unknown> | undefined
      const operatorId = (operator?.open_id as string) ?? ''
      // In card.action.trigger events, message ID is at event.context.open_message_id
      const context = event.context as Record<string, unknown> | undefined
      const messageId =
        (context?.open_message_id as string) ?? (event.message_id as string | undefined)

      return {
        action: decision,
        pauseId: value.pauseId,
        token: value.token,
        operatorId,
        messageId,
      }
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunkerMode: 'text',
    textChunkLimit: CHANNEL_MAX_LENGTH.feishu,

    async sendText(params, config) {
      const { sendFeishuChunked } = await import('../../feishu-sender')
      await sendFeishuChunked(
        config.appId,
        config.appSecret,
        params.receiveId,
        (params.receiveIdType ?? 'open_id') as 'open_id' | 'chat_id' | 'user_id',
        params.content
      )
    },

    async sendFile(params, config) {
      const { sendFeishuFile } = await import('../../feishu-sender')
      await sendFeishuFile(
        config.appId,
        config.appSecret,
        params.receiveId,
        (params.receiveIdType ?? 'open_id') as 'open_id' | 'chat_id' | 'user_id',
        params.file
      )
    },

    async sendCard(params, config) {
      const { sendFeishuCard } = await import('../../feishu-sender')
      return sendFeishuCard(
        config.appId,
        config.appSecret,
        params.receiveId,
        (params.receiveIdType ?? 'open_id') as 'open_id' | 'chat_id' | 'user_id',
        params.card
      )
    },

    async updateCard(params, config) {
      const { updateMessageCard } = await import('../../feishu-client')
      await updateMessageCard(config.appId, config.appSecret, params.messageId, params.card)
    },
  },

  buildApprovalCard(params) {
    const { buildApprovalCard } = require('../../feishu-card-builder')
    return buildApprovalCard({
      sopName: params.sopName,
      nodeName: params.nodeName,
      previousResult: params.previousResult,
      pauseId: params.pauseId,
      approvalToken: params.approvalToken ?? '',
      senderName: params.senderName,
      language: params.language,
    })
  },

  buildApprovalDoneCard(params) {
    const { buildApprovalDoneCard } = require('../../feishu-card-builder')
    return buildApprovalDoneCard(params)
  },
}
