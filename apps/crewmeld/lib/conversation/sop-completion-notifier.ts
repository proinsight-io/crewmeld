/**
 * SOP async completion notification — push results back to IM channels (Feishu/WeCom etc.) when SOP completes
 *
 * Use cases:
 * - SOP still running after 60s timeout
 * - SOP resumed after pausing for manual approval
 * - SSE stream closed, user cannot receive results via streaming response
 *
 * Flow:
 * 1. Find channel_session by conversationId
 * 2. If IM channel (feishu/wecom), find corresponding credentials
 * 3. Format SOP results and send to user
 */

import { channelSessions, conversationMessages, conversations, db } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { desc, eq } from 'drizzle-orm'
import { detect } from 'tinyld'
import { v4 as uuidv4 } from 'uuid'
import {
  resolveAllCredentialsByType,
  resolveCredentialByBoundEmployee,
} from '@/lib/connectors/resolver'
import { t } from '@/lib/core/server-i18n'
import { type FileAttachment, uploadConversationFile } from './file-storage'

const logger = createLogger('SopCompletionNotifier')

interface NotifyParams {
  conversationId: string
  sopName: string
  executionId: string
  output?: string
  files?: Array<{ name: string; mimeType: string; base64: string }>
  /**
   * Attachments already copied from sop/{execId}/outputs/ into
   * conversations/{convId}/ by sop-bridge. Merged into the message's
   * metadata.files alongside any base64-uploaded files.
   */
  workspaceFiles?: FileAttachment[]
  errorMessage?: string
  status: 'completed' | 'failed' | 'error'
}

interface ApprovalDecisionNotifyParams {
  conversationId: string
  sopName: string
  executionId: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  comment?: string
  /** Previous workflow node name */
  previousNodeName?: string
  /** Previous workflow node output (raw JSON) */
  previousNodeResult?: string
}

/**
 * Notify IM channel user after SOP async completion
 */
export async function notifyChannelOnSopCompletion(params: NotifyParams): Promise<void> {
  try {
    // 1. Query conversation channel and digital employee ID
    const [conv] = await db
      .select({
        channel: conversations.channel,
        employeeId: conversations.employeeId,
        workspaceId: conversations.workspaceId,
      })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .limit(1)

    if (!conv) return

    logger.info('SOP completion notification entry', {
      channel: conv.channel,
      conversationId: params.conversationId,
      sopName: params.sopName,
      status: params.status,
    })

    // Store files in MinIO (unified storage for all channels). Two
    // sources are merged:
    //   - params.files  : base64 from non-mount tools, upload now
    //   - params.workspaceFiles : already in conversations/ (copied by
    //                             sop-bridge from sop/{execId}/outputs/),
    //                             use as-is
    let fileMetadata: FileAttachment[] | undefined
    if (
      (params.files && params.files.length > 0) ||
      (params.workspaceFiles && params.workspaceFiles.length > 0)
    ) {
      fileMetadata = []
      for (const f of params.files ?? []) {
        try {
          const buf = Buffer.from(f.base64, 'base64')
          const attachment = await uploadConversationFile(
            params.conversationId,
            f.name,
            buf,
            f.mimeType
          )
          fileMetadata.push(attachment)
        } catch (err) {
          logger.warn('SOP file upload to MinIO failed', { fileName: f.name, error: err })
        }
      }
      if (params.workspaceFiles && params.workspaceFiles.length > 0) {
        fileMetadata.push(...params.workspaceFiles)
      }
    }

    // Web/API channel: write results to conversationMessages, readable by frontend loadMessages
    if (conv.channel === 'web' || conv.channel === 'api') {
      // Infer language from recent user messages
      const recentMsgs = await db
        .select({ content: conversationMessages.content, role: conversationMessages.role })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, params.conversationId))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(10)

      let isZh = true
      for (const msg of recentMsgs) {
        if (msg.role === 'user' && msg.content && msg.content.length >= 4) {
          const langCode = detect(msg.content)
          if (langCode && langCode !== 'zh') {
            isZh = false
          }
          break
        }
      }

      // Non-Chinese scenario: use LLM to translate results to user language
      let translatedOutput = params.output
      if (!isZh && params.output && conv.employeeId) {
        try {
          const { resolveModelConfig } = await import('./model-config')
          const config = await resolveModelConfig(conv.employeeId, conv.workspaceId ?? '')
          const resp = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [
                {
                  role: 'system',
                  content:
                    'Translate the following content to English. Keep the structure and formatting. Only output the translation, nothing else.',
                },
                { role: 'user', content: params.output },
              ],
              max_tokens: 2000,
            }),
          })
          if (resp.ok) {
            const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> }
            translatedOutput = data.choices?.[0]?.message?.content ?? params.output
          }
        } catch (err) {
          logger.warn('SOP result translation failed, using original text', { error: err })
        }
      }

      const message = formatSopResultMessage({ ...params, output: translatedOutput }, isZh)
      await db.insert(conversationMessages).values({
        id: uuidv4(),
        conversationId: params.conversationId,
        role: 'assistant',
        content: message,
        metadata: {
          type: 'sop_completion',
          sopName: params.sopName,
          executionId: params.executionId,
          status: params.status,
          ...(fileMetadata && fileMetadata.length > 0 ? { files: fileMetadata } : {}),
        },
      })
      logger.info('SOP completion notification written to conversation', {
        channel: conv.channel,
        executionId: params.executionId,
        sopName: params.sopName,
        fileCount: fileMetadata?.length ?? 0,
      })
      return
    }

    // IM channel: push via channel API
    if (
      conv.channel !== 'feishu' &&
      conv.channel !== 'wecom' &&
      conv.channel !== 'dingtalk' &&
      conv.channel !== 'discord' &&
      conv.channel !== 'wxoa' &&
      conv.channel !== 'email'
    )
      return

    // 2. Find channel_session to get external user ID
    const [session] = await db
      .select({
        externalUserId: channelSessions.externalUserId,
        externalSessionId: channelSessions.externalSessionId,
      })
      .from(channelSessions)
      .where(eq(channelSessions.conversationId, params.conversationId))
      .limit(1)

    if (!session) {
      logger.warn('SOP completion notification: channel_session not found', {
        conversationId: params.conversationId,
      })
      return
    }

    // 3. Format message (IM channels also do language detection)
    const imRecentMsgs = await db
      .select({ content: conversationMessages.content, role: conversationMessages.role })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, params.conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(10)

    let imIsZh = true
    for (const msg of imRecentMsgs) {
      if (msg.role === 'user' && msg.content && msg.content.length >= 4) {
        const langCode = detect(msg.content)
        if (langCode && langCode !== 'zh') {
          imIsZh = false
        }
        break
      }
    }

    const message = formatSopResultMessage(params, imIsZh)

    // 4. Send text by channel (pass employeeId to match correct channel credentials)
    if (conv.channel === 'feishu') {
      await sendFeishuNotification(
        session.externalUserId,
        session.externalSessionId,
        message,
        conv.employeeId
      )
      // Send attachments
      if (params.files && params.files.length > 0) {
        await sendFeishuFiles(
          session.externalUserId,
          session.externalSessionId,
          params.files,
          conv.employeeId
        )
      }
    } else if (conv.channel === 'wecom') {
      await sendWecomNotification(session.externalUserId, message, conv.employeeId)
      if (params.files && params.files.length > 0) {
        await sendWecomFiles(session.externalUserId, params.files, conv.employeeId)
      }
    } else if (conv.channel === 'dingtalk') {
      await sendDingtalkNotification(
        session.externalUserId,
        session.externalSessionId,
        message,
        conv.employeeId
      )
      if (params.files && params.files.length > 0) {
        await sendDingtalkFiles(
          session.externalUserId,
          session.externalSessionId,
          params.files,
          conv.employeeId
        )
      }
    } else if (conv.channel === 'discord') {
      await sendDiscordNotification(
        session.externalSessionId ?? session.externalUserId,
        message,
        conv.employeeId
      )
    } else if (conv.channel === 'wxoa') {
      await sendWxoaNotification(session.externalUserId, message, conv.employeeId)
    } else if (conv.channel === 'email') {
      const subject = t('sopEmailCompleted', imIsZh ? 'zh' : 'en', { name: params.sopName })
      logger.info('SOP completion notification: sending via email channel', {
        toAddress: session.externalUserId,
        subject,
        sopName: params.sopName,
      })
      await sendEmailNotification(session.externalUserId, subject, message, conv.employeeId)
    }

    // IM channels also write results to conversationMessages (with file metadata), visible in history
    await db.insert(conversationMessages).values({
      id: uuidv4(),
      conversationId: params.conversationId,
      role: 'assistant',
      content: formatSopResultMessage(params),
      metadata: {
        type: 'sop_completion',
        sopName: params.sopName,
        executionId: params.executionId,
        status: params.status,
        ...(fileMetadata && fileMetadata.length > 0 ? { files: fileMetadata } : {}),
      },
    })

    logger.info('SOP completion notification sent', {
      channel: conv.channel,
      executionId: params.executionId,
      sopName: params.sopName,
      fileCount: fileMetadata?.length ?? 0,
    })
  } catch (error) {
    logger.error('SOP completion notification send failed', {
      executionId: params.executionId,
      error,
    })
  }
}

/**
 * Format SOP execution result into user-readable message
 */
function formatSopResultMessage(params: NotifyParams, isZh = true): string {
  const lang = isZh ? 'zh' : 'en'
  if (params.status === 'completed') {
    const header = t('sopCompleted', lang, { name: params.sopName })
    if (params.output) {
      const truncated =
        params.output.length > 2000
          ? params.output.slice(0, 2000) + t('outputTruncated', lang)
          : params.output
      return `${header}\n\n${truncated}`
    }
    return header
  }

  if (params.status === 'failed' || params.status === 'error') {
    const errorDetail = params.errorMessage
      ? `\n${t('sopReason', lang)}: ${params.errorMessage}`
      : ''
    return t('sopFailed', lang, { name: params.sopName }) + errorDetail
  }

  return t('sopStatus', lang, { name: params.sopName, status: params.status })
}

/**
 * Send notification via Feishu
 */
async function sendFeishuNotification(
  externalUserId: string,
  externalSessionId: string | null,
  message: string,
  employeeId?: string
): Promise<void> {
  // Prefer connection bound to digital employee, avoid cross-app
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'feishu')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('feishu'))[0]?.config

  if (!config) {
    logger.warn('Feishu notification: no available credentials')
    return
  }

  if (!config.appId || !config.appSecret) {
    logger.warn('Feishu notification: missing appId/appSecret')
    return
  }

  const { sendFeishuChunked } = await import('@/lib/channels/feishu-sender')

  // Prefer chat_id (group), otherwise use open_id (private chat)
  const receiveId = externalSessionId ?? externalUserId
  const receiveIdType = externalSessionId ? ('chat_id' as const) : ('open_id' as const)

  await sendFeishuChunked(config.appId, config.appSecret, receiveId, receiveIdType, message)
}

/**
 * Send notification via DingTalk
 */
async function sendDingtalkNotification(
  externalUserId: string,
  externalSessionId: string | null,
  message: string,
  employeeId?: string
): Promise<void> {
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'dingtalk')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('dingtalk'))[0]?.config

  if (!config) {
    logger.warn('DingTalk notification: no available credentials')
    return
  }

  if (!config.appKey || !config.appSecret) {
    logger.warn('DingTalk notification: missing appKey/appSecret')
    return
  }

  const robotCode = (config.robotCode as string) || (config.appKey as string)
  const { sendDingtalkChunked } = await import('@/lib/channels/dingtalk-sender')

  // Approval notifications always sent via DM to user (group conversationId incompatible with Robot API openConversationId)
  await sendDingtalkChunked(
    config.appKey as string,
    config.appSecret as string,
    robotCode,
    externalUserId,
    undefined,
    message
  )
}

/**
 * Send approval completion card via DingTalk (new message, as DingTalk does not support updating original cards)
 */
async function sendDingtalkApprovalDoneCard(
  externalUserId: string,
  params: ApprovalDecisionNotifyParams,
  employeeId?: string
): Promise<void> {
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'dingtalk')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('dingtalk'))[0]?.config

  if (!config?.appKey || !config?.appSecret) return

  const robotCode = (config.robotCode as string) || (config.appKey as string)
  const { buildApprovalDoneCard } = await import('@/lib/channels/dingtalk-card-builder')
  const { sendDingtalkActionCard } = await import('@/lib/channels/dingtalk-sender')

  const card = buildApprovalDoneCard({
    sopName: params.sopName,
    nodeName: t('approvalNode'),
    decision: params.decision,
    decidedBy: params.decidedBy,
    decidedAt: new Date(),
  })

  await sendDingtalkActionCard(
    config.appKey as string,
    config.appSecret as string,
    robotCode,
    externalUserId,
    undefined,
    card
  )
}

/**
 * Send attachments via DingTalk (link message + temp download link)
 */
async function sendDingtalkFiles(
  externalUserId: string,
  externalSessionId: string | null,
  files: Array<{ name: string; mimeType: string; base64: string }>,
  employeeId?: string
): Promise<void> {
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'dingtalk')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('dingtalk'))[0]?.config

  if (!config?.appKey || !config?.appSecret) return

  const robotCode = (config.robotCode as string) || (config.appKey as string)
  const { sendDingtalkFile } = await import('@/lib/channels/dingtalk-sender')

  for (const file of files) {
    try {
      await sendDingtalkFile(
        config.appKey as string,
        config.appSecret as string,
        robotCode,
        externalUserId,
        undefined,
        file
      )
      logger.info('DingTalk file notification sent', { fileName: file.name })
    } catch (error) {
      logger.error('DingTalk file notification send failed', { fileName: file.name, error })
    }
  }
}

/**
 * Send attachments via Feishu
 */
async function sendFeishuFiles(
  externalUserId: string,
  externalSessionId: string | null,
  files: Array<{ name: string; mimeType: string; base64: string }>,
  employeeId?: string
): Promise<void> {
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'feishu')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('feishu'))[0]?.config

  if (!config?.appId || !config?.appSecret) return

  const { sendFeishuFile } = await import('@/lib/channels/feishu-sender')

  const receiveId = externalSessionId ?? externalUserId
  const receiveIdType = externalSessionId ? ('chat_id' as const) : ('open_id' as const)

  for (const file of files) {
    try {
      await sendFeishuFile(config.appId, config.appSecret, receiveId, receiveIdType, file)
      logger.info('SOP completion notification: file sent', { fileName: file.name })
    } catch (error) {
      logger.error('SOP completion notification: file send failed', { fileName: file.name, error })
    }
  }
}

/**
 * Send files via WeCom (textcard + temp download link)
 */
async function sendWecomFiles(
  externalUserId: string,
  files: Array<{ name: string; mimeType: string; base64: string }>,
  employeeId?: string
): Promise<void> {
  // Prefer connection bound to digital employee, avoid cross-app
  const credential = employeeId ? await resolveCredentialByBoundEmployee(employeeId, 'wecom') : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('wecom'))[0]?.config

  if (!config?.corpId || !config?.corpSecret || !config?.agentId) return

  const { sendWeComFileAsLink } = await import('@/lib/channels/wecom-sender')

  for (const file of files) {
    try {
      await sendWeComFileAsLink(
        config.corpId,
        config.corpSecret,
        config.agentId,
        externalUserId,
        file
      )
      logger.info('WeCom file notification sent', { fileName: file.name })
    } catch (error) {
      logger.error('WeCom file notification send failed', { fileName: file.name, error })
    }
  }
}

/**
 * Send notification via WeCom
 */
async function sendWecomNotification(
  externalUserId: string,
  message: string,
  employeeId?: string
): Promise<void> {
  // Prefer connection bound to digital employee, avoid cross-app
  const credential = employeeId ? await resolveCredentialByBoundEmployee(employeeId, 'wecom') : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('wecom'))[0]?.config

  if (!config) {
    logger.warn('WeCom notification: no available credentials')
    return
  }

  if (!config.corpId || !config.corpSecret || !config.agentId) {
    logger.warn('WeCom notification: missing corpId/corpSecret/agentId')
    return
  }

  try {
    const { sendWeComChunked } = await import('@/lib/channels/wecom-sender')
    await sendWeComChunked(
      config.corpId,
      config.corpSecret,
      config.agentId,
      externalUserId,
      message
    )
  } catch (error) {
    logger.warn('WeCom notification send failed (wecom-sender may not be implemented)', { error })
  }
}

/**
 * Notify original conversation user after approval decision (Feishu/WeCom)
 *
 * Contains: approval result + previous workflow step output
 */
export async function notifyChannelOnApprovalDecision(
  params: ApprovalDecisionNotifyParams
): Promise<void> {
  // Approval decisions not notified separately, complete execution results sent on SOP completion
  logger.info('Skipping approval decision notification (covered by SOP completion notification)', {
    executionId: params.executionId,
    decision: params.decision,
  })
  return
  /* eslint-disable no-unreachable -- Preserve original IM channel logic, remove above return to restore if needed
  try {
    const [conv] = await db
      .select({
        channel: conversations.channel,
        employeeId: conversations.employeeId,
        workspaceId: conversations.workspaceId,
      })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .limit(1)

    if (!conv) return

    // IM / email channels
    if (conv.channel !== 'feishu' && conv.channel !== 'wecom' && conv.channel !== 'dingtalk' && conv.channel !== 'discord' && conv.channel !== 'wxoa' && conv.channel !== 'email') return

    const [session] = await db
      .select({
        externalUserId: channelSessions.externalUserId,
        externalSessionId: channelSessions.externalSessionId,
      })
      .from(channelSessions)
      .where(eq(channelSessions.conversationId, params.conversationId))
      .limit(1)

    if (!session) {
      logger.warn('Approval notification: channel_session not found', { conversationId: params.conversationId })
      return
    }

    const message = await formatApprovalDecisionMessage(
      params,
      conv.employeeId,
      conv.workspaceId,
    )

    if (conv.channel === 'feishu') {
      await sendFeishuNotification(session.externalUserId, session.externalSessionId, message, conv.employeeId)
    } else if (conv.channel === 'dingtalk') {
      // DingTalk: send approval completion card (original card cannot be updated)
      await sendDingtalkApprovalDoneCard(session.externalUserId, params, conv.employeeId)
    } else if (conv.channel === 'wecom') {
      await sendWecomNotification(session.externalUserId, message, conv.employeeId)
    } else if (conv.channel === 'discord') {
      await sendDiscordNotification(session.externalSessionId ?? session.externalUserId, message, conv.employeeId)
    } else if (conv.channel === 'wxoa') {
      await sendWxoaNotification(session.externalUserId, message, conv.employeeId)
    } else if (conv.channel === 'email') {
      const decisionText = params.decision === 'approved' ? t('approvedShort') : t('rejectedShort')
      await sendEmailNotification(
        session.externalUserId,
        `Re: ${params.sopName} — ${t('approvalDecisionSubject', 'en', { decision: decisionText })}`,
        message,
        conv.employeeId,
      )
    }

    logger.info('Approval decision notification sent', {
      channel: conv.channel,
      executionId: params.executionId,
      sopName: params.sopName,
      decision: params.decision,
    })
  } catch (error) {
    logger.error('Approval decision notification send failed', { executionId: params.executionId, error })
  }
  eslint-enable no-unreachable */
}

/**
 * Format approval decision message (async — may call LLM for summarization)
 */
async function formatApprovalDecisionMessage(
  params: ApprovalDecisionNotifyParams,
  employeeId: string,
  workspaceId: string
): Promise<string> {
  const decisionText = params.decision === 'approved' ? t('approve') : t('reject')
  const lines: string[] = [
    t('approvalDecisionResult', 'en', { name: params.sopName, decision: decisionText }),
  ]

  if (params.comment) {
    lines.push(`${t('approvalComment', 'en')}: ${params.comment}`)
  }

  if (params.previousNodeName && params.previousNodeResult) {
    lines.push('')
    lines.push(`${t('previousResult', 'en')} (${params.previousNodeName}):`)

    const summarized = await summarizeResultWithLLM(
      params.previousNodeResult,
      employeeId,
      workspaceId
    )
    lines.push(summarized)
  }

  return lines.join('\n')
}

/**
 * Use LLM to summarize workflow JSON output into natural language
 *
 * Degradation strategy: truncate and return raw text when LLM unavailable
 */
async function summarizeResultWithLLM(
  jsonResult: string,
  employeeId?: string,
  workspaceId?: string
): Promise<string> {
  // If content does not look like JSON (plain text), return directly
  const trimmed = jsonResult.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return truncateText(trimmed)
  }

  if (!employeeId || !workspaceId) {
    return truncateText(jsonResult)
  }

  try {
    const { resolveModelConfig } = await import('./model-config')
    const config = await resolveModelConfig(employeeId, workspaceId)

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: t('summarizePrompt'),
          },
          {
            role: 'user',
            content: jsonResult.slice(0, 4000),
          },
        ],
        stream: false,
        max_tokens: 500,
      }),
    })

    if (!response.ok) {
      logger.warn('LLM summarization failed, falling back to raw text', { status: response.status })
      return truncateText(jsonResult)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()

    if (content) {
      return content
    }

    return truncateText(jsonResult)
  } catch (error) {
    logger.warn('LLM summarization error, falling back to raw text', { error })
    return truncateText(jsonResult)
  }
}

/**
 * Send notification via Discord
 *
 * channelId is Discord channel ID (from channel_session.externalSessionId)
 */
async function sendDiscordNotification(
  channelId: string,
  message: string,
  employeeId?: string
): Promise<void> {
  const credential = employeeId
    ? await resolveCredentialByBoundEmployee(employeeId, 'discord')
    : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('discord'))[0]?.config

  if (!config?.botToken) {
    logger.warn('Discord notification: no available credentials or missing botToken')
    return
  }

  try {
    const { discordFetch } = await import('@/lib/channels/plugins/discord/fetch')

    // Discord single message limit 2000 chars, send in chunks for longer messages
    const limit = 2000
    const chunks: string[] = []
    let remaining = message
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining)
        break
      }
      let cutPos = remaining.lastIndexOf('\n', limit)
      if (cutPos < limit * 0.5) cutPos = limit
      chunks.push(remaining.slice(0, cutPos))
      remaining = remaining.slice(cutPos)
    }

    for (const chunk of chunks) {
      await discordFetch(`/channels/${channelId}/messages`, config.botToken, {
        method: 'POST',
        body: JSON.stringify({ content: chunk }),
      })
    }

    logger.info('Discord SOP notification sent', { channelId })
  } catch (error) {
    logger.error('Discord notification send failed', { channelId, error })
  }
}

/**
 * Send notification via WeChat Official Account
 */
async function sendWxoaNotification(
  externalUserId: string,
  message: string,
  employeeId?: string
): Promise<void> {
  const credential = employeeId ? await resolveCredentialByBoundEmployee(employeeId, 'wxoa') : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('wxoa'))[0]?.config

  if (!config) {
    logger.warn('WeChat OA notification: no available credentials')
    return
  }

  if (!config.appId || !config.appSecret) {
    logger.warn('WeChat OA notification: missing appId/appSecret')
    return
  }

  try {
    const { sendWxoaChunked } = await import('@/lib/channels/wxoa-sender')
    await sendWxoaChunked(config.appId, config.appSecret, externalUserId, message)
  } catch (error) {
    logger.error('WeChat OA notification send failed', { error })
  }
}

function truncateText(text: string, maxLen = 2000): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + t('outputTruncated')
}

/**
 * Send email notification via SMTP (email channel)
 */
async function sendEmailNotification(
  toAddress: string,
  subject: string,
  message: string,
  employeeId?: string
): Promise<void> {
  const credential = employeeId ? await resolveCredentialByBoundEmployee(employeeId, 'email') : null

  const config = credential
    ? credential.config
    : (await resolveAllCredentialsByType('email'))[0]?.config

  if (!config?.smtpHost || !config?.username || !config?.password) {
    logger.warn('Email notification: missing SMTP configuration')
    return
  }

  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.default.createTransport({
      host: config.smtpHost as string,
      port: (config.smtpPort as number) || 465,
      secure: (config.smtpSecure as boolean) ?? true,
      auth: {
        user: config.username as string,
        pass: config.password as string,
      },
    })

    const fromAddress = (config.fromAddress as string) ?? (config.username as string)
    const fromName = (config.fromName as string) ?? t('emailSender')

    await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: toAddress,
      subject,
      text: message,
      html: `<pre style="font-family:sans-serif;white-space:pre-wrap;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
    })

    logger.info('Email notification sent', { toAddress, subject })
  } catch (error) {
    logger.error('Email notification send failed', { toAddress, subject, error })
  }
}
