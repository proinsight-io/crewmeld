import { db, digitalEmployees } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { filterEmployeeDatasets } from '@/lib/conversation/chat-knowledge'
import { listDatasets, loadRagflowConfig } from '@/lib/ragflow'
import { reconcileAndMergeDatasetMetadata } from '@/lib/ragflow/knowledge-metadata'
import { knowledgeMetadataRepository } from '@/lib/ragflow/knowledge-metadata-repository'

const logger = createLogger('EmployeeChatKnowledgeBasesAPI')

/** Return only enabled knowledge bases bound to the selected employee. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('employee:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)

  try {
    const { id } = await params
    const [employee] = await db
      .select({ config: digitalEmployees.config })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, id))
      .limit(1)
    if (!employee) return apiErr('api.employee.notFound', { status: 404 })

    const config = (employee.config as Record<string, unknown> | null) ?? {}
    const boundIds = Array.isArray(config.ragflowDatasetIds)
      ? config.ragflowDatasetIds.filter((value): value is string => typeof value === 'string')
      : []
    if (boundIds.length === 0) return apiOk([])

    const ragflowConfig = await loadRagflowConfig()
    const datasets = await listDatasets(ragflowConfig, { page: 1, pageSize: 100 })
    const merged = await reconcileAndMergeDatasetMetadata(knowledgeMetadataRepository, datasets)
    return apiOk(filterEmployeeDatasets(boundIds, merged))
  } catch (error) {
    logger.error('Failed to load employee chat knowledge bases', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    return apiErr('api.ragflow.datasetListFailed', { status: 502 })
  }
}
