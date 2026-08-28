import { db, digitalEmployees, knowledgeBases } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { apiErr, apiOk } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { listTopFrequentQuestions } from '@/lib/knowledge/analytics/repository'

const logger = createLogger('API:Public:Knowledge:TopQuestions')

/** Return historical Top-N questions for an employee-bound enabled dataset. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ employeeId: string; datasetId: string }> }
) {
  const { employeeId, datasetId } = await params
  try {
    const auth = await authenticateEmployeeApiKey(request, employeeId)
    if (!auth.ok)
      return apiErr('api.common.unauthorized', {
        status: auth.reason === 'origin_denied' ? 403 : 401,
      })
    const rawTopN = new URL(request.url).searchParams.get('topN') ?? '3'
    if (!/^\d+$/.test(rawTopN) || Number(rawTopN) < 1 || Number(rawTopN) > 100)
      return apiErr('api.common.invalidParams', {
        status: 400,
        extra: { code: 'QA_TOPN_INVALID' },
      })
    const [employee] = await db
      .select({ config: digitalEmployees.config })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, employeeId))
      .limit(1)
    const config = (employee?.config as Record<string, unknown> | null) ?? {}
    const boundIds = Array.isArray(config.ragflowDatasetIds) ? config.ragflowDatasetIds : []
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
    logger.error('Failed to fetch top frequent questions', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    return apiErr('api.common.internalError', { status: 500 })
  }
}
