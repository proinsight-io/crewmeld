import { db } from '@crewmeld/db'
import { type ContactMethod, humanEmployees } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { getPlugin } from '@/lib/channels/plugin-registry'
import type { ChannelPlugin } from '@/lib/channels/plugin-types'
import { t } from '@/lib/core/server-i18n'
import '@/lib/channels/plugins'

const logger = createLogger('NotificationDispatcher')

interface DispatchResult {
  contactType: string
  contactValue: string
  status: 'dry_run' | 'sent' | 'no_credential' | 'error'
  message: string
}

interface ApprovalNotificationContent {
  subject: string
  body: string
  pauseId?: string
  sopName?: string
  nodeName?: string
  aiSummary?: string
  deadline?: string
  previousNodeResult?: string
  previousNodeName?: string
  approvalPageUrl?: string
  approveUrl?: string
  rejectUrl?: string
  /** Name of user who triggered conversation (displayed on approval card) */
  senderName?: string
  /** Email of user who triggered conversation (sender address for email channel) */
  senderEmail?: string
  /** User language code ('zh' | 'en'), for multilingual approval cards */
  language?: string
}

/**
 * Dispatch notification to collaborator
 *
 * WeCom channel: send approval card (template_card)
 * Other channels: dry-run log recording
 */
export async function dispatchNotification(
  recipientId: string,
  notificationContent: ApprovalNotificationContent,
  notifyMethod?: string | string[],
  sourceEmployeeId?: string
): Promise<DispatchResult[]> {
  const rows = await db
    .select({
      contactMethods: humanEmployees.contactMethods,
      name: humanEmployees.name,
    })
    .from(humanEmployees)
    .where(eq(humanEmployees.id, recipientId))
    .limit(1)

  if (rows.length === 0) {
    logger.warn('Notification delivery failed: recipient not found', { recipientId })
    return []
  }

  const allContacts = rows[0].contactMethods as ContactMethod[]
  if (!allContacts || allContacts.length === 0) {
    logger.warn('Notification delivery failed: recipient has no contact info', {
      recipientId,
      name: rows[0].name,
    })
    return []
  }

  // Determine delivery method list: supports multi-platform (string | string[])
  const methods: string[] = notifyMethod
    ? Array.isArray(notifyMethod)
      ? notifyMethod
      : [notifyMethod]
    : allContacts.find((c) => c.type === 'email')
      ? ['email']
      : allContacts[0]?.type
        ? [allContacts[0].type]
        : []

  if (methods.length === 0) {
    logger.warn('Notification delivery skipped: recipient has no contact info', {
      recipientId,
      name: rows[0].name,
    })
    return []
  }

  // Multi-platform: collect all matching contact methods
  const contacts = allContacts.filter((c) => methods.includes(c.type))

  if (contacts.length === 0) {
    logger.warn('Notification delivery failed: no matching contact method for recipient', {
      recipientId,
      notifyMethod: methods,
      name: rows[0].name,
    })
    return []
  }

  const results: DispatchResult[] = []

  for (const contact of contacts) {
    // Try sending approval card via plugin registry
    const plugin = getPlugin(contact.type)
    if (plugin?.buildApprovalCard && plugin.outbound.sendCard && notificationContent.pauseId) {
      try {
        const result = await sendApprovalViaPlugin(
          plugin,
          contact.value,
          notificationContent,
          sourceEmployeeId
        )
        results.push(result)
        continue
      } catch (error) {
        logger.error('Approval card send failed', {
          recipientId,
          contactValue: contact.value,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        })
        results.push({
          contactType: contact.type,
          contactValue: contact.value,
          status: 'error',
          message: error instanceof Error ? error.message : `${plugin.label} card send failed`,
        })
        continue
      }
    }

    // Email channel: send HTML approval confirmation email
    if (contact.type === 'email' && notificationContent.approvalPageUrl) {
      try {
        const result = await sendEmailApproval(
          contact.value,
          notificationContent,
          notificationContent.senderEmail
        )
        results.push(result)
        continue
      } catch (error) {
        logger.error('Approval confirmation email send failed', { recipientId, error })
        results.push({
          contactType: contact.type,
          contactValue: contact.value,
          status: 'error',
          message: error instanceof Error ? error.message : t('emailSendFailed'),
        })
        continue
      }
    }

    // Other channels: dry-run
    logger.info('Notification delivery (dry-run)', {
      recipientId,
      recipientName: rows[0].name,
      contactType: contact.type,
      contactValue: contact.value,
      subject: notificationContent.subject,
    })

    results.push({
      contactType: contact.type,
      contactValue: contact.value,
      status: 'dry_run',
      message: 'MVP dry-run: logged, not actually sent',
    })
  }

  return results
}

/**
 * Send an approval card directly to a channel-native user id (e.g. the
 * requester's leader from `_meta.identity.leaderId`), on the given channel.
 *
 * Reuses the generic plugin sender (which resolves the channel credential and
 * builds the card). Returns the dispatch result on success, or `null` when the
 * channel can't send or the send fails (e.g. the leader id is invalid/stale) so
 * the caller can fall back to the configured assignee.
 */
export async function dispatchApprovalToChannelUser(
  channel: string,
  userId: string,
  content: ApprovalNotificationContent,
  sourceEmployeeId?: string
): Promise<DispatchResult | null> {
  const plugin = getPlugin(channel)
  if (!plugin?.buildApprovalCard || !plugin.outbound.sendCard || !content.pauseId) {
    logger.warn('Leader routing skipped: channel cannot send approval cards', { channel })
    return null
  }

  try {
    const result = await sendApprovalViaPlugin(plugin, userId, content, sourceEmployeeId)
    if (result.status === 'sent') {
      logger.info('Approval card delivered to leader', { channel, leaderId: userId })
      return result
    }
    // no_credential / dry_run / error → let the caller fall back
    logger.warn('Leader routing did not deliver; will fall back', {
      channel,
      leaderId: userId,
      status: result.status,
    })
    return null
  } catch (error) {
    // Invalid/stale leader id, channel rejection, etc. — fall back.
    logger.warn('Leader routing send failed; will fall back', {
      channel,
      leaderId: userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Send approval card via channel plugin (generic)
 */
async function sendApprovalViaPlugin(
  plugin: ChannelPlugin,
  toUser: string,
  content: ApprovalNotificationContent,
  sourceEmployeeId?: string
): Promise<DispatchResult> {
  const { resolveCredentialByBoundEmployee, resolveSystemDefault, resolveCredentialById } =
    await import('@/lib/connectors/resolver')
  const { getNotificationBotChannelId } = await import('@/lib/connectors/notification-bot')

  // Prefer admin-designated notification bot, then bound connection, finally system default
  const designatedChannelId = await getNotificationBotChannelId(plugin.id)
  let credential = designatedChannelId ? await resolveCredentialById(designatedChannelId) : null

  if (!credential && sourceEmployeeId) {
    credential = await resolveCredentialByBoundEmployee(
      sourceEmployeeId,
      plugin.id as import('@crewmeld/db/schema').ConnectionType
    )
  }
  if (!credential) {
    credential = await resolveSystemDefault(
      plugin.id as import('@crewmeld/db/schema').ConnectionType
    )
  }

  if (!credential) {
    return {
      contactType: plugin.id,
      contactValue: toUser,
      status: 'no_credential',
      message: `No available ${plugin.label} system connection`,
    }
  }

  // Extract token from approveUrl (format: .../approval/{pauseId}?token=xxx&decision=approved)
  let approvalToken: string | undefined
  if (content.approveUrl) {
    try {
      const u = new URL(content.approveUrl)
      approvalToken = u.searchParams.get('token') ?? undefined
    } catch {
      /* ignore */
    }
  }

  logger.info('Preparing to send approval card', {
    toUser,
    connectionId: credential.connectionId,
    connectionName: credential.connectionName,
    sourceEmployeeId,
    designatedChannelId,
  })

  const card = plugin.buildApprovalCard!({
    pauseId: content.pauseId!,
    sopName: content.sopName ?? 'SOP',
    nodeName: content.nodeName ?? t('approvalNode', content.language),
    aiSummary: content.aiSummary,
    deadline: content.deadline,
    approvalPageUrl: content.approvalPageUrl,
    approvalToken,
    senderName: content.senderName,
    previousResult: content.previousNodeResult,
    language: content.language,
  })

  const cardResponseCode = await plugin.outbound.sendCard!(
    { receiveId: toUser, receiveIdType: 'user_id', card },
    credential.config as Record<string, unknown>
  )

  // Save response_code to database (needed for WeCom card update)
  if (cardResponseCode && content.pauseId) {
    try {
      const { db: dbInner } = await import('@crewmeld/db')
      const { sopPauseStates } = await import('@crewmeld/db/schema')
      const { eq: eqInner } = await import('drizzle-orm')
      await dbInner
        .update(sopPauseStates)
        .set({ cardResponseCode })
        .where(eqInner(sopPauseStates.id, content.pauseId))
      logger.info('response_code saved', { pauseId: content.pauseId })
    } catch (err) {
      logger.warn('Failed to save response_code', { error: err })
    }
  }

  logger.info('Approval card sent', {
    toUser,
    pauseId: content.pauseId,
    hasResponseCode: !!cardResponseCode,
  })

  return {
    contactType: plugin.id,
    contactValue: toUser,
    status: 'sent',
    message: `${plugin.label} approval card sent`,
  }
}

/**
 * Send approval confirmation email via email channel
 */
async function sendEmailApproval(
  toAddress: string,
  content: ApprovalNotificationContent,
  senderEmail?: string
): Promise<DispatchResult> {
  const { resolveSystemDefault } = await import('@/lib/connectors/resolver')
  const credential = await resolveSystemDefault('email')

  if (!credential) {
    return {
      contactType: 'email',
      contactValue: toAddress,
      status: 'no_credential',
      message: t('noEmailConnection'),
    }
  }

  const { smtpHost, smtpPort, smtpSecure, username, password, fromName, fromAddress } =
    credential.config as Record<string, unknown>

  if (!smtpHost || !smtpPort || !username || !password) {
    return {
      contactType: 'email',
      contactValue: toAddress,
      status: 'no_credential',
      message: t('emailConfigIncomplete'),
    }
  }

  const { sendApprovalEmail } = await import('@/lib/channels/email-sender')

  await sendApprovalEmail({
    toAddress,
    sopName: content.sopName ?? 'SOP',
    nodeName: content.nodeName ?? t('pendingNode', content.language),
    approvalPageUrl: content.approvalPageUrl!,
    approveUrl: content.approveUrl,
    rejectUrl: content.rejectUrl,
    aiSummary: content.aiSummary,
    deadline: content.deadline,
    previousNodeResult: content.previousNodeResult,
    previousNodeName: content.previousNodeName,
    replyTo: senderEmail,
    language: content.language,
    smtpConfig: {
      smtpHost,
      smtpPort: Number(smtpPort),
      smtpSecure,
      username,
      password,
      fromName,
      fromAddress,
    },
  })

  logger.info('Approval confirmation email sent', { toAddress, pauseId: content.pauseId })

  return {
    contactType: 'email',
    contactValue: toAddress,
    status: 'sent',
    message: t('emailSent'),
  }
}
