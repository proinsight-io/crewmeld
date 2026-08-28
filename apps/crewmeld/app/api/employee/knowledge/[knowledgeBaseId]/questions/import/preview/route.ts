import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { validateQaCsvFile } from '@/lib/knowledge/qa/csv-validation'
import { signQaImportToken } from '@/lib/knowledge/qa/import-token'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'
import {
  assertQaKnowledgeBase,
  csvRowsToInputs,
  QaServiceError,
  rejectExistingDuplicates,
} from '@/lib/knowledge/qa/service'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeBaseId: string }> }
) {
  const auth = await requirePermission(QA_PERMISSIONS.import)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  if (!auth.userId)
    return apiErr('api.common.forbidden', {
      status: 403,
      extra: { code: 'QA_IMPORT_ACTOR_REQUIRED' },
    })
  const { knowledgeBaseId } = await params
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
    const file = (await request.formData()).get('file')
    if (!(file instanceof File))
      return apiErr('api.ragflow.documentFileMissing', {
        status: 400,
        extra: { code: 'QA_IMPORT_FILE_REQUIRED' },
      })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    const validation = await validateQaCsvFile(file)
    const invalidRows = new Set(
      validation.errors.flatMap((error) => (error.row ? [error.row] : []))
    )
    const validRows = validation.rows.filter((row) => !invalidRows.has(row.row))
    let duplicates: Array<{ id: string; normalizedQuestion: string }> = []
    try {
      await rejectExistingDuplicates(
        qaQuestionRepository,
        knowledgeBaseId,
        csvRowsToInputs(validRows)
      )
    } catch (error) {
      if (!(error instanceof QaServiceError) || error.code !== 'QA_DUPLICATE_QUESTION') throw error
      duplicates = (
        error.details as { conflicts: Array<{ id: string; normalizedQuestion: string }> }
      ).conflicts
    }
    const token =
      validation.valid && duplicates.length === 0
        ? signQaImportToken({ knowledgeBaseId, digest, actorId: auth.userId })
        : null
    return apiOk({
      rows: validRows.slice(0, 100),
      validRowCount: validRows.length,
      errorCount: validation.errors.length,
      errors: validation.errors,
      duplicates,
      previewRowLimit: 100,
      token,
    })
  } catch (error) {
    const code = error instanceof QaServiceError ? error.code : 'QA_IMPORT_PREVIEW_FAILED'
    return apiErr('api.common.invalidParams', {
      status: error instanceof QaServiceError ? error.status : 400,
      extra: { code },
    })
  }
}
