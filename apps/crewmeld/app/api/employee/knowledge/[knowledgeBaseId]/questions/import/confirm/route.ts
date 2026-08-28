import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { validateQaCsvFile } from '@/lib/knowledge/qa/csv-validation'
import { verifyQaImportToken } from '@/lib/knowledge/qa/import-token'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'
import {
  assertQaKnowledgeBase,
  csvRowsToInputs,
  QaServiceError,
  rejectExistingDuplicates,
} from '@/lib/knowledge/qa/service'
import { enqueueQaBatchSync, mutateThenEnqueue } from '@/lib/knowledge/qa/sync-service'

export const POST = withAudit(
  async (request: NextRequest, { params }: { params: Promise<{ knowledgeBaseId: string }> }) => {
    const auth = await requirePermission(QA_PERMISSIONS.import)
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)
    if (!auth.userId)
      return apiErr('api.common.forbidden', {
        status: 403,
        extra: { code: 'QA_IMPORT_ACTOR_REQUIRED' },
      })
    const actorId = auth.userId
    const { knowledgeBaseId } = await params
    try {
      await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
      const form = await request.formData()
      const file = form.get('file')
      const token = form.get('token')
      if (!(file instanceof File) || typeof token !== 'string')
        return apiErr('api.common.invalidParams', {
          status: 400,
          extra: { code: 'QA_IMPORT_INPUT_REQUIRED' },
        })
      const bytes = new Uint8Array(await file.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (!verifyQaImportToken(token, { knowledgeBaseId, digest, actorId }))
        return apiErr('api.common.forbidden', {
          status: 403,
          extra: { code: 'QA_IMPORT_TOKEN_INVALID' },
        })
      const validation = await validateQaCsvFile(file)
      if (!validation.valid)
        return apiErr('api.common.invalidParams', {
          status: 400,
          extra: { code: 'QA_IMPORT_VALIDATION_FAILED', errors: validation.errors },
        })
      const rows = csvRowsToInputs(validation.rows)
      await rejectExistingDuplicates(qaQuestionRepository, knowledgeBaseId, rows)
      const result = await mutateThenEnqueue(
        async () => {
          const value = await qaQuestionRepository.importBatch(
            knowledgeBaseId,
            rows,
            digest,
            file.name,
            actorId
          )
          return { value, batchId: value.batchId }
        },
        enqueueQaBatchSync,
        'import'
      )
      return apiOk({ ...result.value, syncPending: result.syncPending }, { status: 201 })
    } catch (error) {
      const code = error instanceof QaServiceError ? error.code : 'QA_IMPORT_FAILED'
      return apiErr('api.common.invalidParams', {
        status: error instanceof QaServiceError ? error.status : 500,
        extra: { code, details: error instanceof QaServiceError ? error.details : undefined },
      })
    }
  }
)
