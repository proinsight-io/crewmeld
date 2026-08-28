import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { validateQaCsvFile } from '@/lib/knowledge/qa/csv-validation'
import { knowledgeMetadataRepository } from '@/lib/ragflow/knowledge-metadata-repository'

const MAX_PREVIEW_ROWS = 100

/** Validates a QA CSV and returns a bounded preview without importing data. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('knowledge:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)

  const { id } = await params
  const [metadata] = await knowledgeMetadataRepository.findByDatasetIds([id])
  if (metadata?.type !== 'qa') {
    return apiErr('api.ragflow.qaPreviewTypeInvalid', {
      status: 409,
      extra: { code: 'QA_PREVIEW_TYPE_INVALID' },
    })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) return apiErr('api.ragflow.documentFileMissing', { status: 400 })

  const result = await validateQaCsvFile(file)
  const invalidRows = new Set(result.errors.flatMap((error) => (error.row ? [error.row] : [])))
  const validRows = result.rows.filter((row) => !invalidRows.has(row.row))
  return apiOk({
    headers: result.headers,
    rows: validRows.slice(0, MAX_PREVIEW_ROWS),
    validRowCount: validRows.length,
    previewRowLimit: MAX_PREVIEW_ROWS,
    errors: result.errors,
  })
}
