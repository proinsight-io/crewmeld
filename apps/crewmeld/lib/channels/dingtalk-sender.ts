/**
 * DingTalk message sending service
 */

import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import { chunkForChannel } from './chunk'
import { sendGroupChatMessage, sendSingleChatMessage } from './dingtalk-client'

const logger = createLogger('DingtalkSender')

/**
 * Sanitize Markdown syntax not supported by DingTalk.
 *
 * DingTalk robot Markdown does not render GFM tables, and folds single newlines
 * into whitespace (only blank lines start a new paragraph). Tables are converted
 * to bullet lists so each row renders on its own line.
 *
 * Idempotent — calling twice on the same input is safe.
 */
export function sanitizeForDingtalk(md: string): string {
  const lines = md.split('\n')
  const result: string[] = []
  let inTable = false
  let tableHeaders: string[] = []

  const stripBoldWrap = (s: string): string => s.replace(/^\*\*(.*)\*\*$/, '$1').trim()

  const ensureBlankBefore = () => {
    if (result.length > 0 && result[result.length - 1].trim() !== '') {
      result.push('')
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Table separator row -> skip
    if (/^\|[\s:?-]+\|/.test(trimmed) && !trimmed.replace(/[\s|:-]/g, '')) {
      continue
    }

    // Table row -> convert to bullet list item
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
      if (!inTable) {
        inTable = true
        tableHeaders = cells
        ensureBlankBefore()
        continue
      }
      const colon = t('channelCardColon')
      if (cells.length === 2) {
        // Field/value table: "- **field**: value"
        const field = stripBoldWrap(cells[0])
        result.push(`- **${field}**${colon}${cells[1]}`)
      } else {
        // Multi-column: "- **header1**: cell1  **header2**: cell2"
        const parts = cells.map((cell, i) => {
          const header = tableHeaders[i] ? stripBoldWrap(tableHeaders[i]) : ''
          return header ? `**${header}**${colon}${cell}` : cell
        })
        result.push(`- ${parts.join('  ')}`)
      }
      continue
    }

    if (inTable) {
      inTable = false
      tableHeaders = []
      // Close list block with a blank line
      if (result.length > 0 && result[result.length - 1].trim() !== '') {
        result.push('')
      }
    }
    result.push(line)
  }

  return result.join('\n')
}

/**
 * Send DingTalk Markdown message (auto-chunked)
 */
export async function sendDingtalkChunked(
  appKey: string,
  appSecret: string,
  robotCode: string,
  userId: string,
  conversationId: string | undefined,
  content: string
): Promise<void> {
  const sanitized = sanitizeForDingtalk(content)
  const chunks = chunkForChannel(sanitized, 'dingtalk')

  for (const chunk of chunks) {
    await sendDingtalkMarkdown(appKey, appSecret, robotCode, userId, conversationId, chunk)
  }
}

/**
 * Send a single Markdown message
 */
export async function sendDingtalkMarkdown(
  appKey: string,
  appSecret: string,
  robotCode: string,
  userId: string,
  conversationId: string | undefined,
  content: string
): Promise<void> {
  const title = content.slice(0, 20).replace(/[#*\n]/g, '') || 'Message'
  const msgParam = JSON.stringify({ title, text: content })

  if (conversationId) {
    await sendGroupChatMessage(
      appKey,
      appSecret,
      robotCode,
      conversationId,
      'sampleMarkdown',
      msgParam
    )
  } else {
    await sendSingleChatMessage(appKey, appSecret, robotCode, [userId], 'sampleMarkdown', msgParam)
  }
}

/**
 * Send DingTalk ActionCard message (approval card)
 */
export async function sendDingtalkActionCard(
  appKey: string,
  appSecret: string,
  robotCode: string,
  userId: string,
  conversationId: string | undefined,
  card: Record<string, unknown>
): Promise<void> {
  const msgParam = JSON.stringify(card)

  if (conversationId) {
    await sendGroupChatMessage(
      appKey,
      appSecret,
      robotCode,
      conversationId,
      'sampleActionCard6',
      msgParam
    )
  } else {
    await sendSingleChatMessage(
      appKey,
      appSecret,
      robotCode,
      [userId],
      'sampleActionCard6',
      msgParam
    )
  }
}

/**
 * Send file message
 *
 * Prefers DingTalk native file message (upload -> send sampleFile),
 * falls back to link message + temporary download URL.
 */
/**
 * Send file message (upload to DingTalk -> send sampleFile)
 */
export async function sendDingtalkFile(
  appKey: string,
  appSecret: string,
  robotCode: string,
  userId: string,
  conversationId: string | undefined,
  file: { name: string; mimeType: string; base64: string }
): Promise<void> {
  try {
    const { uploadRobotFile } = await import('./dingtalk-client')
    const buffer = Buffer.from(file.base64, 'base64')
    const mediaId = await uploadRobotFile(appKey, appSecret, file.name, buffer)

    const msgParam = JSON.stringify({ mediaId, fileName: file.name })

    if (conversationId) {
      await sendGroupChatMessage(
        appKey,
        appSecret,
        robotCode,
        conversationId,
        'sampleFile',
        msgParam
      )
    } else {
      await sendSingleChatMessage(appKey, appSecret, robotCode, [userId], 'sampleFile', msgParam)
    }
    logger.info('DingTalk file message sent successfully', { fileName: file.name })
  } catch (error) {
    logger.error('DingTalk file send failed', {
      fileName: file.name,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
