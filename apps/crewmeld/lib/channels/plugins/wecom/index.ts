/**
 * WeCom channel plugin — wraps existing wecom-adapter / wecom-sender / wecom-card-builder / wecom-crypto
 */

import { t } from '@/lib/core/server-i18n'
import type { ApprovalDoneCardParams, CardActionEvent, ChannelPlugin } from '../../plugin-types'
import type { ChannelMessage } from '../../types'
import { CHANNEL_MAX_LENGTH } from '../../types'
import { extractXmlTag } from '../../wecom-adapter'
import { decryptWeComMessage, generateWeComSignature } from '../../wecom-crypto'
import { type WeComPluginConfig, wecomPluginConfigSchema } from './types'

/** File extensions that support text content extraction */
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

export const wecomPlugin: ChannelPlugin<WeComPluginConfig> = {
  id: 'wecom',
  label: t('channelPluginWecom'),
  aliases: ['wechat-work', 'wxwork'],
  identityRawFields: [
    { path: 'name', label: '姓名' },
    { path: 'email', label: '邮箱' },
    { path: 'mobile', label: '手机' },
    { path: 'userid', label: '成员UserID' },
    { path: 'position', label: '职务' },
    { path: 'department', label: '部门ID列表' },
    { path: 'deptNames', label: '部门名' },
    { path: 'direct_leader.0', label: '直属上级UserID' },
  ],

  capabilities: {
    direct: true,
    channel: false,
    threads: false,
    media: true,
    reactions: false,
    editing: false,
    replies: false,
    cards: true,
    websocket: false,
  },

  configSchema: wecomPluginConfigSchema,

  inbound: {
    async verifySignature(request, bodyText, config) {
      const url = new URL(request.url)
      const msgSignature = url.searchParams.get('msg_signature') ?? ''
      const timestamp = url.searchParams.get('timestamp') ?? ''
      const nonce = url.searchParams.get('nonce') ?? ''

      const encryptedContent = extractXmlTag(bodyText, 'Encrypt')
      console.log('[wecom] verifySignature', {
        hasBody: !!bodyText,
        bodyLen: bodyText?.length,
        hasEncrypt: !!encryptedContent,
        encryptFirst10: encryptedContent?.slice(0, 10),
        tokenFirst4: config.token?.slice(0, 4),
        msgSignature,
        timestamp,
        nonce,
      })
      if (!encryptedContent) return false

      const expectedSig = generateWeComSignature(config.token, timestamp, nonce, encryptedContent)
      console.log(`[wecom] ${t('channelWecomSignCompare')}`, {
        computed: expectedSig,
        expected: msgSignature,
        match: expectedSig === msgSignature,
      })
      return expectedSig === msgSignature
    },

    async handleVerification(body, config) {
      // WeCom URL verification via GET request, not this method
      // But handles possible encrypted challenge in POST
      return null
    },

    decryptPayload(body, config) {
      // WeCom messages are passed via XML body; decryption is handled in parseMessage
      return null
    },

    parseMessage(body, config): ChannelMessage | null {
      // body contains the raw XML text (passed by webhook handler via __rawXml field)
      const rawXml = body.__rawXml as string | undefined
      if (!rawXml) return null

      const encryptedContent = extractXmlTag(rawXml, 'Encrypt')
      if (!encryptedContent) return null

      const { message: decryptedXml } = decryptWeComMessage(config.encodingAESKey, encryptedContent)

      const msgType = extractXmlTag(decryptedXml, 'MsgType')
      const fromUser = extractXmlTag(decryptedXml, 'FromUserName')
      const msgId = extractXmlTag(decryptedXml, 'MsgId') || `wecom-${Date.now()}`
      const createTime = extractXmlTag(decryptedXml, 'CreateTime')

      console.log('[wecom] parseMessage', { msgType, fromUser, msgId })

      // File message: extract MediaId and FileName, downloaded asynchronously by webhook-handler
      if (msgType === 'file' && fromUser) {
        const mediaId = extractXmlTag(decryptedXml, 'MediaId')
        const fileName = extractXmlTag(decryptedXml, 'FileName') || 'unknown'

        if (!mediaId) return null

        // All file types are downloaded and stored to MinIO; text files additionally have content extracted for LLM
        return {
          channel: 'wecom',
          externalUserId: fromUser,
          messageId: msgId,
          content: `[User sent a file: ${fileName}]`,
          messageType: 'file',
          timestamp: Number(createTime) * 1000 || Date.now(),
          rawPayload: { body: decryptedXml },
          _pendingFile: { fileName, mediaId, corpId: config.corpId, corpSecret: config.corpSecret },
        } as ChannelMessage & { _pendingFile: Record<string, string> }
      }

      // Unsupported message type: return a hint
      if (msgType && msgType !== 'text' && msgType !== 'event' && fromUser) {
        const typeNames: Record<string, string> = {
          image: 'image',
          voice: 'voice',
          video: 'video',
          location: 'location',
          link: 'link',
        }
        const typeName = typeNames[msgType] ?? msgType
        return {
          channel: 'wecom',
          externalUserId: fromUser,
          messageId: msgId,
          content: `[User sent a ${typeName} message. Only text messages are currently supported. Please send your content as text]`,
          messageType: 'text',
          timestamp: Number(createTime) * 1000 || Date.now(),
          rawPayload: { body: decryptedXml },
        }
      }

      if (msgType !== 'text') return null

      const content = extractXmlTag(decryptedXml, 'Content')

      if (!content || !fromUser) return null

      return {
        channel: 'wecom',
        externalUserId: fromUser,
        messageId: msgId,
        content,
        messageType: 'text',
        timestamp: Number(createTime) * 1000 || Date.now(),
        rawPayload: { body: decryptedXml },
      }
    },

    parseCardAction(body, config): CardActionEvent | null {
      const rawXml = body.__rawXml as string | undefined
      if (!rawXml) {
        console.log(`[wecom] parseCardAction: ${t('channelWecomNone')} __rawXml`)
        return null
      }

      const encryptedContent = extractXmlTag(rawXml, 'Encrypt')
      if (!encryptedContent) {
        console.log(
          `[wecom] parseCardAction: ${t('channelWecomNone')} Encrypt ${t('channelWecomNoTag')}`
        )
        return null
      }

      const { message: decryptedXml } = decryptWeComMessage(config.encodingAESKey, encryptedContent)

      const msgType = extractXmlTag(decryptedXml, 'MsgType')
      const event = extractXmlTag(decryptedXml, 'Event')
      const eventKey = extractXmlTag(decryptedXml, 'EventKey')
      console.log(`[wecom] parseCardAction ${t('channelWecomDecryptResult')}`, {
        msgType,
        event,
        eventKey: eventKey?.slice(0, 30),
      })

      if (msgType !== 'event') return null
      if (event !== 'template_card_event') return null

      const fromUser = extractXmlTag(decryptedXml, 'FromUserName')
      const taskId = extractXmlTag(decryptedXml, 'TaskId')
      const responseCode = extractXmlTag(decryptedXml, 'ResponseCode')
      console.log(`[wecom] parseCardAction ${t('channelWecomDetail')}`, {
        eventKey,
        fromUser,
        taskId,
        responseCode: responseCode?.slice(0, 20),
      })

      if (!eventKey.startsWith('approval_')) return null

      // EventKey format: approval_{pauseId}_{decision}
      // pauseId itself may contain _ (e.g. pause_Ec-s8Z2drDook7u), so extract decision from the end
      const lastUnderscore = eventKey.lastIndexOf('_')
      const decision = eventKey.slice(lastUnderscore + 1)
      const pauseId = eventKey.slice('approval_'.length, lastUnderscore)
      if (decision !== 'approved' && decision !== 'rejected') return null
      if (!pauseId) return null

      return {
        action: decision,
        pauseId,
        operatorId: fromUser,
        // Use responseCode from callback to update the card (WeCom generates a new responseCode per callback)
        taskId: responseCode || taskId,
        rawPayload: { body: decryptedXml },
      }
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunkerMode: 'markdown',
    textChunkLimit: CHANNEL_MAX_LENGTH.wecom,

    async sendText(params, config) {
      const { sendWeComChunked } = await import('../../wecom-sender')
      await sendWeComChunked(
        config.corpId,
        config.corpSecret,
        config.agentId,
        params.receiveId,
        params.content
      )
    },

    async sendFile(params, config) {
      const { sendWeComFile } = await import('../../wecom-sender')
      await sendWeComFile(
        config.corpId,
        config.corpSecret,
        config.agentId,
        params.receiveId,
        params.file
      )
    },

    async sendCard(params, config) {
      const { sendApprovalCard } = await import('../../wecom-sender')
      return sendApprovalCard(
        config.corpId,
        config.corpSecret,
        config.agentId,
        params.receiveId,
        params.card
      )
    },

    async updateCard(params, config) {
      const { updateApprovalCardStatus } = await import('../../wecom-sender')
      await updateApprovalCardStatus(
        config.corpId,
        config.corpSecret,
        config.agentId,
        params.messageId,
        params.card,
        params.toUser
      )
    },
  },

  buildApprovalCard(params) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildApprovalCard } =
      require('../../wecom-card-builder') as typeof import('../../wecom-card-builder')
    return buildApprovalCard({
      pauseId: params.pauseId,
      sopName: params.sopName,
      nodeName: params.nodeName,
      senderName: params.senderName,
      previousResult: params.previousResult,
      aiSummary: params.aiSummary,
      deadline: params.deadline,
      approvalPageUrl: params.approvalPageUrl,
      language: params.language,
    })
  },

  buildApprovalDoneCard(params: ApprovalDoneCardParams) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildApprovalDoneCard } =
      require('../../wecom-card-builder') as typeof import('../../wecom-card-builder')
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
