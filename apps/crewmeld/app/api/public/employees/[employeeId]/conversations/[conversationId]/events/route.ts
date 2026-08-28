import { conversations, db, digitalEmployees, humanHandoffs } from '@crewmeld/db'
import { knowledgeBases } from '@crewmeld/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { apiErr, apiOk } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'

const Body = z.object({
  type: z.string().min(1).max(100),
  knowledgeBaseId: z.string().min(1).max(200).optional(),
  topN: z.number().int().min(1).max(20).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

/** Process a non-persistent navigation or service-mode event. */
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

  if (parsed.data.type === 'service_mode.changed') {
    const mode = parsed.data.data?.mode
    if (mode === 'ai') {
      await db
        .update(humanHandoffs)
        .set({ status: 'resolved', updatedAt: new Date() })
        .where(
          and(
            eq(humanHandoffs.conversationId, conversationId),
            inArray(humanHandoffs.status, ['open', 'assigned'])
          )
        )
      return apiOk({ accepted: true, persisted: false, mode: 'ai' })
    }
    if (mode === 'human' || mode === 'human_service') {
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
      return apiOk({ accepted: true, persisted: false, mode: 'human_service' })
    }
    return apiErr('api.common.invalidParams', { status: 400 })
  }

  if (parsed.data.type !== 'knowledge_base.selected' || !parsed.data.knowledgeBaseId)
    return apiOk({ accepted: true, persisted: false })
  const [employee] = await db
    .select({ config: digitalEmployees.config })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)
  const employeeConfig = (employee?.config as Record<string, unknown> | null) ?? {}
  const boundIds = Array.isArray(employeeConfig.ragflowDatasetIds)
    ? employeeConfig.ragflowDatasetIds
    : []
  if (!boundIds.includes(parsed.data.knowledgeBaseId))
    return apiErr('api.common.notFound', { status: 404 })
  const [knowledgeBase] = await db
    .select({ id: knowledgeBases.id, type: knowledgeBases.type })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.ragflowDatasetId, parsed.data.knowledgeBaseId))
    .limit(1)
  if (!knowledgeBase || knowledgeBase.type !== 'qa')
    return apiOk({
      accepted: true,
      persisted: false,
      knowledgeBaseId: parsed.data.knowledgeBaseId,
      questions: [],
    })
  const result = await qaQuestionRepository.list(knowledgeBase.id, {
    page: 1,
    pageSize: parsed.data.topN ?? 3,
    enabled: true,
  })
  return apiOk({
    accepted: true,
    persisted: false,
    knowledgeBaseId: parsed.data.knowledgeBaseId,
    questions: result.rows,
  })
}
