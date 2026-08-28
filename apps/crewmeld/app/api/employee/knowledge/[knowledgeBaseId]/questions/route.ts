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
  rejectExistingDuplicates,
} from '@/lib/knowledge/qa/service'
import type { QaQuestionInput } from '@/lib/knowledge/qa/types'

function failure(error: unknown) {
  return error instanceof QaServiceError
    ? apiErr('api.common.invalidParams', {
        status: error.status,
        extra: { code: error.code, details: error.details },
      })
    : apiErr('api.common.internalError', { status: 500 })
}
const SYNC_STATUSES = new Set(['pending', 'syncing', 'active', 'failed', 'superseded'])
function positiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeBaseId: string }> }
) {
  const auth = await requirePermission(QA_PERMISSIONS.view)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId } = await params
  try {
    await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
    const search = request.nextUrl.searchParams
    const page = positiveInteger(search.get('page'), 1)
    const requestedPageSize = positiveInteger(search.get('pageSize'), 20)
    const syncStatus = search.get('syncStatus')
    if (
      page === null ||
      requestedPageSize === null ||
      (syncStatus !== null && !SYNC_STATUSES.has(syncStatus))
    )
      return apiErr('api.common.invalidParams', {
        status: 400,
        extra: { code: 'QA_LIST_FILTER_INVALID' },
      })
    const pageSize = Math.min(100, requestedPageSize)
    const enabledRaw = search.get('enabled')
    if (enabledRaw !== null && enabledRaw !== 'true' && enabledRaw !== 'false')
      return apiErr('api.common.invalidParams', {
        status: 400,
        extra: { code: 'QA_LIST_FILTER_INVALID' },
      })
    const enabled = enabledRaw === null ? undefined : enabledRaw === 'true'
    const result = await qaQuestionRepository.list(knowledgeBaseId, {
      page,
      pageSize,
      keyword: search.get('keyword')?.trim() || undefined,
      enabled,
      tag: search.get('tag')?.trim() || undefined,
      syncStatus: (syncStatus ?? undefined) as
        | 'pending'
        | 'syncing'
        | 'active'
        | 'failed'
        | 'superseded'
        | undefined,
    })
    return apiOk(result.rows, { extra: { pagination: { page, pageSize, total: result.total } } })
  } catch (error) {
    return failure(error)
  }
}

export const POST = withAudit(
  async (request: NextRequest, { params }: { params: Promise<{ knowledgeBaseId: string }> }) => {
    const auth = await requirePermission(QA_PERMISSIONS.edit)
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)
    const { knowledgeBaseId } = await params
    try {
      await assertQaKnowledgeBase(qaQuestionRepository, knowledgeBaseId)
      const input = parseQuestionInput(await request.json()) as QaQuestionInput
      await rejectExistingDuplicates(qaQuestionRepository, knowledgeBaseId, [input])
      const value = await qaQuestionRepository.create(knowledgeBaseId, input, auth.userId!)
      return apiOk({ ...value, syncPending: false }, { status: 201 })
    } catch (error) {
      return failure(error)
    }
  }
)
