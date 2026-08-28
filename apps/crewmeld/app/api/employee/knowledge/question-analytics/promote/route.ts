import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { markQuestionGroupPromoted } from '@/lib/knowledge/analytics/repository'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'
import { assertQaKnowledgeBase, rejectExistingDuplicates } from '@/lib/knowledge/qa/service'

const Body = z.object({
  groupId: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  question: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(20000),
})

export const POST = withAudit(async (request: Request) => {
  const auth = await requirePermission(QA_PERMISSIONS.edit)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, parsed.data.knowledgeBaseId)
    const input = {
      question: parsed.data.question,
      answer: parsed.data.answer,
      enabled: true,
      sortOrder: 0,
      tags: ['高频问题'],
    }
    await rejectExistingDuplicates(qaQuestionRepository, parsed.data.knowledgeBaseId, [input])
    const qa = await qaQuestionRepository.create(parsed.data.knowledgeBaseId, input, auth.userId!)
    const group = await markQuestionGroupPromoted(
      parsed.data.groupId,
      parsed.data.question,
      parsed.data.answer,
      qa.id
    )
    if (!group) return apiErr('api.common.notFound', { status: 404 })
    return apiOk({ group, qaQuestion: qa, syncPending: true }, { status: 201 })
  } catch (error) {
    return apiErr('api.common.invalidParams', {
      status: 409,
      extra: { code: error instanceof Error ? error.message : 'PROMOTE_FAILED' },
    })
  }
})
