import type { NextRequest } from 'next/server'
import { createLogger } from '@crewmeld/logger'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listUnansweredQuestions } from '@/lib/knowledge/unanswered/service'

const logger = createLogger('UnansweredQuestionsAPI')

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('employee:list')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)
    const page = Number(request.nextUrl.searchParams.get('page') ?? '1')
    const pageSize = Number(request.nextUrl.searchParams.get('pageSize') ?? '10')
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      return apiErr('api.common.invalidParams', { status: 400 })
    const { id } = await params
    const result = await listUnansweredQuestions(id, page, pageSize)
    return apiOk({
      ...result,
      page,
      pageSize,
      rows: result.rows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt.toISOString() })),
    })
  } catch (error) {
    logger.error('Failed to list unanswered questions', error)
    return apiErr('api.common.internalError', { status: 500 })
  }
}
