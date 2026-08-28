import { conversationMessages, conversations, db, humanHandoffs } from '@crewmeld/db'
import { and, eq, or, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { apiErr } from '@/lib/api/response'
import { getSession } from '@/lib/auth'
import { encodeSSE, SSE_HEADERS } from '@/lib/core/utils/sse'
import { canSupportEmployee } from '@/lib/human-service/authorization'
import { canReplyToHandoff } from '@/lib/human-service/handoff-ownership'

const Body = z.object({
  content: z.string().min(1).max(20000),
  assigneeId: z.string().min(1).optional(),
})

/** POST collaborator reply to a human-service conversation. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const { id } = await params
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  const [handoff] = await db
    .select({ handoff: humanHandoffs, employeeId: conversations.employeeId })
    .from(humanHandoffs)
    .innerJoin(conversations, eq(conversations.id, humanHandoffs.conversationId))
    .where(
      and(
        eq(humanHandoffs.conversationId, id),
        or(eq(humanHandoffs.status, 'open'), eq(humanHandoffs.status, 'assigned'))
      )
    )
    .limit(1)
  if (!handoff) return apiErr('api.conversation.notFound', { status: 404 })
  if (!(await canSupportEmployee(handoff.employeeId, session.user.id)))
    return apiErr('api.common.forbidden', { status: 403 })
  const current = handoff.handoff
  const agentId = session.user.id
  if (!canReplyToHandoff(current, agentId)) {
    return apiErr('api.common.forbidden', { status: 403 })
  }
  await db.insert(conversationMessages).values({
    id: uuidv4(),
    conversationId: id,
    role: 'assistant',
    content: parsed.data.content,
    metadata: {
      source: 'human_agent',
      senderType: 'human_agent',
      agentId,
      agentName: session.user.name ?? session.user.email ?? '人工客服',
    },
  })
  await db
    .update(humanHandoffs)
    .set({
      status: 'assigned',
      assigneeId: current.assigneeId,
      claimedByUserId: current.claimedByUserId ?? agentId,
      updatedAt: new Date(),
    })
    .where(eq(humanHandoffs.id, current.id))
  await db
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + 1`,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeSSE({ chunk: parsed.data.content, source: 'human_agent' }))
      controller.enqueue(encodeSSE({ done: true }))
      controller.close()
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}
