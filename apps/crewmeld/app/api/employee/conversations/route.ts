import { conversationMessages, conversations, db, digitalEmployees } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { getSession } from '@/lib/auth'
import { createConversationGreeting } from '@/lib/conversation/greeting'
import { resolveWebIdentity } from '@/lib/identity/web-identity'

const logger = createLogger('ConversationsAPI')

const CreateConversationSchema = z.object({
  employeeId: z.string().min(1),
  channel: z.enum(['web', 'wecom', 'dingtalk', 'feishu', 'api', 'wxoa']).default('web'),
})

/**
 * POST /api/employee/conversations — Create conversation
 */
async function _POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session?.user?.id) {
      return apiErr('api.common.unauthorized', { status: 401 })
    }

    const body = await request.json()
    const parsed = CreateConversationSchema.safeParse(body)
    if (!parsed.success) {
      return apiErr('api.common.invalidParams', { status: 400 })
    }

    const { employeeId, channel } = parsed.data

    // Verify employee exists
    const [employee] = await db
      .select({ id: digitalEmployees.id, config: digitalEmployees.config })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, employeeId))
      .limit(1)

    if (!employee) {
      return apiErr('api.employee.notFound', { status: 404 })
    }

    const workspaceId =
      ((session.session as Record<string, unknown>)?.activeOrganizationId as string) ??
      session.user.id

    const conversationId = uuidv4()
    const now = new Date()
    const identity = channel === 'web' ? await resolveWebIdentity(session.user.id) : null
    const greeting = createConversationGreeting(
      employee.config,
      { id: session.user.id, name: session.user.name, email: session.user.email },
      identity
    )
    const greetingMessage = greeting
      ? {
          id: uuidv4(),
          role: 'assistant' as const,
          content: greeting,
          metadata: { source: 'greeting' },
          createdAt: now.toISOString(),
        }
      : null
    await db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: conversationId,
        employeeId,
        userId: session.user.id,
        workspaceId,
        channel,
        messageCount: greetingMessage ? 1 : 0,
        lastMessageAt: greetingMessage ? now : null,
        metadata: {
          senderName: session.user.name ?? undefined,
        },
      })
      if (greetingMessage) {
        await tx.insert(conversationMessages).values({
          id: greetingMessage.id,
          conversationId,
          role: greetingMessage.role,
          content: greetingMessage.content,
          metadata: greetingMessage.metadata,
          createdAt: now,
        })
      }
    })

    logger.info(`Conversation created: ${conversationId}, employee=${employeeId}`)

    return apiOk(
      {
        id: conversationId,
        employeeId,
        channel,
        status: 'active',
        createdAt: now.toISOString(),
        greetingMessage,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error('Failed to create conversation', error)
    return apiErr('api.conversation.createFailed', { status: 500 })
  }
}

/**
 * GET /api/employee/conversations — Conversation list
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session?.user?.id) {
      return apiErr('api.common.unauthorized', { status: 401 })
    }

    const url = new URL(request.url)
    const employeeId = url.searchParams.get('employeeId')
    const status = url.searchParams.get('status')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100)

    const conditions = [gt(conversations.messageCount, 0)]
    if (employeeId) {
      // Admin view: show all channel conversations for an employee (including email, WeCom and other external channels)
      conditions.push(eq(conversations.employeeId, employeeId))
    } else {
      // Personal view: only show conversations initiated by current user
      conditions.push(eq(conversations.userId, session.user.id))
    }
    if (status === 'active' || status === 'closed' || status === 'archived') {
      conditions.push(eq(conversations.status, status))
    } else {
      // Exclude closed conversations by default
      conditions.push(ne(conversations.status, 'closed'))
    }

    const rows = await db
      .select({
        id: conversations.id,
        employeeId: conversations.employeeId,
        employeeName: digitalEmployees.name,
        employeeAvatar: digitalEmployees.avatar,
        channel: conversations.channel,
        status: conversations.status,
        title: conversations.title,
        messageCount: conversations.messageCount,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .leftJoin(digitalEmployees, eq(conversations.employeeId, digitalEmployees.id))
      .where(and(...conditions))
      .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`))
      .limit(limit)

    const data = rows.map((row) => ({
      ...row,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }))

    return apiOk(data)
  } catch (error) {
    logger.error('Failed to fetch conversation list', error)
    return apiErr('api.conversation.fetchListFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
