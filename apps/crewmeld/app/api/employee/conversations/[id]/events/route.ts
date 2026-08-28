import { conversationMessages, conversations, db, humanHandoffs } from '@crewmeld/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiErr, apiOk } from '@/lib/api/response'
import { getSession } from '@/lib/auth'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'

const HUMAN_SERVICE_KB_NAME = '\u4eba\u5de5\u5ba2\u670d'
const ACTIVE_HANDOFF_STATUSES = ['open', 'assigned'] as const

const EventSchema = z.object({
  type: z.string().min(1).max(100),
  knowledgeBaseId: z.string().min(1).max(200).optional(),
  topN: z.number().int().min(1).max(20).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

async function isConversationOwner(conversationId: string, userId: string): Promise<boolean> {
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1)
  return Boolean(conversation)
}

/** Return the current service mode for a conversation owner. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const { id } = await params
  if (!(await isConversationOwner(id, session.user.id)))
    return apiErr('api.conversation.notFound', { status: 404 })

  const [handoff] = await db
    .select({ id: humanHandoffs.id, status: humanHandoffs.status })
    .from(humanHandoffs)
    .where(
      and(
        eq(humanHandoffs.conversationId, id),
        inArray(humanHandoffs.status, ACTIVE_HANDOFF_STATUSES)
      )
    )
    .limit(1)
  return apiOk({
    mode: handoff ? 'human_service' : 'ai',
    handoffId: handoff?.id ?? null,
    handoffStatus: handoff?.status ?? null,
  })
}

/** Handle navigation and service-mode events. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const { id } = await params
  if (!(await isConversationOwner(id, session.user.id)))
    return apiErr('api.conversation.notFound', { status: 404 })

  const parsed = EventSchema.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })

  const isModeChange = parsed.data.type === 'service_mode.changed'
  const requestedMode = parsed.data.data?.mode
  if (
    isModeChange &&
    requestedMode !== 'ai' &&
    requestedMode !== 'human' &&
    requestedMode !== 'human_service'
  ) {
    return apiErr('api.common.invalidParams', { status: 400 })
  }

  if (isModeChange && requestedMode === 'ai') {
    await db
      .update(humanHandoffs)
      .set({ status: 'resolved', updatedAt: new Date() })
      .where(
        and(
          eq(humanHandoffs.conversationId, id),
          inArray(humanHandoffs.status, ACTIVE_HANDOFF_STATUSES)
        )
      )
    return apiOk(
      { accepted: true, persisted: false, mode: 'ai' },
      { extra: { eventType: parsed.data.type } }
    )
  }

  const requestsHumanService =
    parsed.data.type === 'human_customer_message' ||
    (isModeChange && (requestedMode === 'human' || requestedMode === 'human_service')) ||
    parsed.data.knowledgeBaseId === HUMAN_SERVICE_KB_NAME ||
    parsed.data.knowledgeBaseId === 'human_service' ||
    parsed.data.knowledgeBaseId === 'human-service'

  if (requestsHumanService) {
    if (parsed.data.type === 'human_customer_message') {
      const content = typeof parsed.data.data?.content === 'string' ? parsed.data.data.content : ''
      if (content.trim()) {
        await db.insert(conversationMessages).values({
          id: crypto.randomUUID(),
          conversationId: id,
          role: 'user',
          content,
          metadata: { source: 'human_service', files: parsed.data.data?.files ?? [] },
        })
        await db
          .update(conversations)
          .set({
            messageCount: sql`${conversations.messageCount} + 1`,
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, id))
      }
    }

    const [existing] = await db
      .select({ id: humanHandoffs.id })
      .from(humanHandoffs)
      .where(
        and(
          eq(humanHandoffs.conversationId, id),
          inArray(humanHandoffs.status, ACTIVE_HANDOFF_STATUSES)
        )
      )
      .limit(1)
    if (!existing) {
      await db
        .insert(humanHandoffs)
        .values({ id: crypto.randomUUID(), conversationId: id, status: 'open' })
    }
    return apiOk(
      { accepted: true, persisted: false, mode: 'human_service' },
      { extra: { eventType: parsed.data.type } }
    )
  }

  if (parsed.data.type !== 'knowledge_base.selected')
    return apiOk({ accepted: true, persisted: false })
  if (!parsed.data.knowledgeBaseId) return apiErr('api.common.invalidParams', { status: 400 })
  const result = await qaQuestionRepository.list(parsed.data.knowledgeBaseId, {
    page: 1,
    pageSize: parsed.data.topN ?? 3,
    enabled: true,
  })
  return apiOk(
    {
      accepted: true,
      persisted: false,
      knowledgeBaseId: parsed.data.knowledgeBaseId,
      questions: result.rows,
    },
    { extra: { eventType: parsed.data.type } }
  )
}
