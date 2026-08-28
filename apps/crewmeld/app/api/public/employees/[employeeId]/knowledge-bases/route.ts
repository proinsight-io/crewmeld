import { db, digitalEmployees } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { apiErr, apiOk } from '@/lib/api/response'
import { filterEmployeeDatasets } from '@/lib/conversation/chat-knowledge'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { listDatasets, loadRagflowConfig } from '@/lib/ragflow'
import { reconcileAndMergeDatasetMetadata } from '@/lib/ragflow/knowledge-metadata'
import { knowledgeMetadataRepository } from '@/lib/ragflow/knowledge-metadata-repository'

/** List enabled knowledge bases bound to a published employee. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
    })
  const [employee] = await db
    .select({ config: digitalEmployees.config })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)
  if (!employee) return apiErr('api.employee.notFound', { status: 404 })
  const config = (employee.config as Record<string, unknown> | null) ?? {}
  const boundIds = Array.isArray(config.ragflowDatasetIds)
    ? config.ragflowDatasetIds.filter((value): value is string => typeof value === 'string')
    : []
  if (boundIds.length === 0) return apiOk([])
  const datasets = await listDatasets(await loadRagflowConfig(), { page: 1, pageSize: 100 })
  const merged = await reconcileAndMergeDatasetMetadata(knowledgeMetadataRepository, datasets)
  const metadata = new Map(merged.map((dataset) => [dataset.id, dataset.metadata.id]))
  return apiOk(
    filterEmployeeDatasets(boundIds, merged).map((dataset) => ({
      ...dataset,
      knowledgeBaseId: metadata.get(dataset.id),
    }))
  )
}
