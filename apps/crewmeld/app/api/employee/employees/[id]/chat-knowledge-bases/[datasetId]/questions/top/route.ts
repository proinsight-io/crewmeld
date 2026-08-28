import { db, digitalEmployees, knowledgeBases } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listTopFrequentQuestions } from '@/lib/knowledge/analytics/repository'

const logger = createLogger('API:Employee:ChatKnowledge:TopQuestions')

/** Return historical Top-N questions for an employee-bound enabled dataset. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; datasetId: string }> }
) {
  const auth = await requirePermission('employee:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)

  const rawTopN = request.nextUrl.searchParams.get('topN') ?? '3'
  if (!/^\d+$/.test(rawTopN) || Number(rawTopN) < 1 || Number(rawTopN) > 100) {
    return apiErr('api.common.invalidParams', {
      status: 400,
      extra: { code: 'QA_TOPN_INVALID' },
    })
  }

  try {
    const { id, datasetId } = await params
    const [employee] = await db
      .select({ config: digitalEmployees.config })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, id))
      .limit(1)
    if (!employee) return apiErr('api.common.notFound', { status: 404 })

    const config = (employee.config as Record<string, unknown> | null) ?? {}
    const boundIds = Array.isArray(config.ragflowDatasetIds)
      ? config.ragflowDatasetIds.filter((value): value is string => typeof value === 'string')
      : []
    if (!boundIds.includes(datasetId)) return apiErr('api.common.notFound', { status: 404 })

    const [knowledgeBase] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(
        and(eq(knowledgeBases.ragflowDatasetId, datasetId), eq(knowledgeBases.enabled, true))
      )
      .limit(1)
    if (!knowledgeBase) return apiErr('api.common.notFound', { status: 404 })

    const rows = await listTopFrequentQuestions(knowledgeBase.id, Number(rawTopN))
    return apiOk(rows, { extra: { topN: Number(rawTopN), datasetId } })
  } catch (error) {
    logger.error('Failed to fetch chat top questions', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    return apiErr('api.common.internalError', { status: 500 })
  }
}
