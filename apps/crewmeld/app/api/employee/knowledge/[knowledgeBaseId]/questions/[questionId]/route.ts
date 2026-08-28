import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'
import {
  assertQaKnowledgeBase,
  parseQuestionInput,
  QaServiceError,
} from '@/lib/knowledge/qa/service'

type Context = { params: Promise<{ knowledgeBaseId: string; questionId: string }> }

function serviceError(error: unknown) {
  if (error instanceof QaServiceError)
    return apiErr('api.common.invalidParams', {
      status: error.status,
      extra: { code: error.code, details: error.details },
    })
  return apiErr('api.common.internalError', { status: 500, extra: { code: 'QA_INTERNAL_ERROR' } })
}

export const PATCH = withAudit(async (request: NextRequest, { params }: Context) => {
  const auth = await requirePermission(QA_PERMISSIONS.edit)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId, questionId } = await params
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new QaServiceError('QA_VALIDATION_FAILED', 400)
    const record = body as Record<string, unknown>
    if (!Number.isSafeInteger(record.version))
      throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field: 'version' })
    const { version, ...patch } = record
    const input = parseQuestionInput(patch, true)
    const row = await qaQuestionRepository.update(
      questionId,
      knowledgeBaseId,
      input,
      version as number,
      auth.userId ?? ''
    )
    if (!row)
      return apiErr('api.common.conflict', { status: 409, extra: { code: 'QA_VERSION_CONFLICT' } })
    return apiOk({ ...row, syncPending: false })
  } catch (error) {
    return serviceError(error)
  }
})

export const DELETE = withAudit(async (_request: NextRequest, { params }: Context) => {
  const auth = await requirePermission(QA_PERMISSIONS.remove)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId, questionId } = await params
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
    if (!(await qaQuestionRepository.remove(questionId, knowledgeBaseId)))
      return apiErr('api.common.notFound', {
        status: 404,
        extra: { code: 'QA_QUESTION_NOT_FOUND' },
      })
    return apiOk({ id: questionId, syncPending: false })
  } catch (error) {
    return serviceError(error)
  }
})
