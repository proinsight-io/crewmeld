import type { NextRequest } from 'next/server'
import { db, knowledgeBases } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listTopFrequentQuestions } from '@/lib/knowledge/analytics/repository'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'

const logger = createLogger('API:Knowledge:TopQuestions')

/** Returns historical high-frequency questions for an enabled knowledge base. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeBaseId: string }> }
) {
  const auth = await requirePermission(QA_PERMISSIONS.view)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId } = await params
  const raw = request.nextUrl.searchParams.get('topN') ?? '3'
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)
    return apiErr('api.common.invalidParams', { status: 400, extra: { code: 'QA_TOPN_INVALID' } })
  try {
    const [knowledgeBase] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.enabled, true)))
      .limit(1)
    if (!knowledgeBase) return apiErr('api.common.notFound', { status: 404 })

    const rows = await listTopFrequentQuestions(knowledgeBaseId, Number(raw))
    return apiOk(rows, { extra: { topN: Number(raw) } })
  } catch (error) {
    logger.error('Failed to fetch top frequent questions', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    return apiErr('api.common.internalError', { status: 500 })
  }
}
