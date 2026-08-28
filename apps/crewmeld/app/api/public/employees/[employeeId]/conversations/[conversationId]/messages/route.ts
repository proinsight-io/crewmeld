import { conversationMessages, conversations, db, humanHandoffs } from '@crewmeld/db'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { apiErr } from '@/lib/api/response'
import { processMessage } from '@/lib/conversation/engine'
import { SSE_HEADERS } from '@/lib/core/utils/sse'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { parseKnowledgeBaseQuery } from '@/lib/employee-api/origin-policy'

const FileAttachment = z.object({
  key: z.string().min(1).max(1000),
  name: z.string().min(1).max(500),
  size: z.number().int().min(0),
  mimeType: z.string().min(1).max(200),
})

const Body = z.object({
  content: z.string().max(10000),
  knowledgeBaseIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  serviceMode: z.enum(['ai', 'human_service']).optional(),
  files: z.array(FileAttachment).max(5).optional(),
}).refine((body) => body.content.trim().length > 0 || (body.files?.length ?? 0) > 0, {
  message: 'content or files required',
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ employeeId: string; conversationId: string }> }
) {
  const { employeeId, conversationId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
    })
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.employeeId, employeeId),
        eq(conversations.userId, auth.principal.actorId)
      )
    )
    .limit(1)
  if (!conversation) return apiErr('api.common.notFound', { status: 404 })
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  const querySelection = parseKnowledgeBaseQuery(new URL(request.url).searchParams)
  const knowledgeBaseIds = querySelection.length > 0 ? querySelection : parsed.data.knowledgeBaseIds

  if (parsed.data.serviceMode === 'human_service') {
    const [existingHandoff] = await db
      .select({ id: humanHandoffs.id })
      .from(humanHandoffs)
      .where(
        and(eq(humanHandoffs.conversationId, conversationId), eq(humanHandoffs.status, 'open'))
      )
      .limit(1)
    if (!existingHandoff)
      await db
        .insert(humanHandoffs)
        .values({ id: crypto.randomUUID(), conversationId, status: 'open' })
    await db.insert(conversationMessages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content: parsed.data.content,
      metadata: {
        serviceMode: 'human_service',
        apiKeyId: auth.principal.keyId,
        ...(parsed.data.files?.length ? { files: parsed.data.files } : {}),
      },
    })
    await db
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + 1`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"mode":"human_service","accepted":true}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { headers: SSE_HEADERS }
    )
  }

  const stream = await processMessage(
    conversationId,
    parsed.data.content,
    auth.principal.actorId,
    parsed.data.files,
    undefined,
    undefined,
    undefined,
    knowledgeBaseIds
  )
  return new Response(stream, { headers: SSE_HEADERS })
}
