import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { createQaCsvStream } from '@/lib/knowledge/qa/export-stream'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { qaQuestionRepository } from '@/lib/knowledge/qa/repository'
import { assertQaKnowledgeBase, QaServiceError } from '@/lib/knowledge/qa/service'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeBaseId: string }> }
) {
  const auth = await requirePermission(QA_PERMISSIONS.export)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId } = await params
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
    const enabledValue = request.nextUrl.searchParams.get('enabled')
    if (enabledValue !== null && enabledValue !== 'true' && enabledValue !== 'false')
      return apiErr('api.common.invalidParams', {
        status: 400,
        extra: { code: 'QA_EXPORT_FILTER_INVALID' },
      })
    const enabled = enabledValue === null ? undefined : enabledValue === 'true'
    const stream = createQaCsvStream(qaQuestionRepository.exportPages(knowledgeBaseId, enabled))
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="qa-${knowledgeBaseId}.csv"`,
      },
    })
  } catch (error) {
    const code = error instanceof QaServiceError ? error.code : 'QA_EXPORT_FAILED'
    return apiErr('api.common.invalidParams', {
      status: error instanceof QaServiceError ? error.status : 500,
      extra: { code },
    })
  }
}
