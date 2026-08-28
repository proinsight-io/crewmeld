import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listFrequentQuestions } from '@/lib/knowledge/analytics/repository'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'

export async function GET(request: NextRequest) {
  const auth = await requirePermission(QA_PERMISSIONS.view)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const search = request.nextUrl.searchParams
  const page = Math.max(1, Number(search.get('page') ?? 1))
  const pageSize = Math.min(100, Math.max(1, Number(search.get('pageSize') ?? 20)))
  const sort = search.get('sort') === 'recent' ? 'recent' : 'count'
  if (!Number.isFinite(page) || !Number.isFinite(pageSize))
    return apiErr('api.common.invalidParams', { status: 400 })
  const result = await listFrequentQuestions({
    keyword: search.get('keyword')?.trim() || undefined,
    knowledgeBaseId: search.get('knowledgeBaseId')?.trim() || undefined,
    status: search.get('status')?.trim() || undefined,
    page,
    pageSize,
    sort,
  })
  return apiOk(result.rows, { extra: { pagination: { page, pageSize, total: result.total } } })
}
