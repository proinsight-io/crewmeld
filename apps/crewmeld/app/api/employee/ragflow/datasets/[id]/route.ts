import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  getDataset,
  loadRagflowConfig,
  RagflowClientError,
  updateDataset,
} from '@/lib/ragflow'
import {
  ImmutableKnowledgeBaseTypeError,
  InvalidKnowledgeThresholdError,
  reconcileAndMergeDatasetMetadata,
  updateKnowledgeMetadata,
} from '@/lib/ragflow/knowledge-metadata'
import { knowledgeMetadataRepository } from '@/lib/ragflow/knowledge-metadata-repository'
import type { KnowledgeBaseType } from '@crewmeld/db/schema'

const logger = createLogger('RagflowDatasetDetailAPI')

/**
 * GET /api/employee/ragflow/datasets/[id] — Knowledge base detail
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const config = await loadRagflowConfig()
    const dataset = await getDataset(config, id)

    const [result] = await reconcileAndMergeDatasetMetadata(knowledgeMetadataRepository, [dataset])
    return apiOk(result)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to fetch knowledge base detail', error)
    return apiErr('api.ragflow.datasetDetailFailed', { status: 500 })
  }
}

/**
 * PUT /api/employee/ragflow/datasets/[id] — Update knowledge base name and/or description
 */
async function _PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const body = (await request.json()) as { name?: string; description?: string }

    const patch: { name?: string; description?: string } = {}
    if (body.name !== undefined) {
      const trimmed = body.name.trim()
      if (!trimmed) {
        return apiErr('api.ragflow.datasetNameRequired', { status: 400 })
      }
      patch.name = trimmed
    }
    if (body.description !== undefined) {
      patch.description = body.description.trim()
    }

    if (Object.keys(patch).length === 0) {
      return apiErr('api.ragflow.datasetUpdateNoChange', { status: 400 })
    }

    const config = await loadRagflowConfig()
    await updateDataset(config, id, patch)
    const dataset = await getDataset(config, id)

    return apiOk(dataset)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to update knowledge base', error)
    return apiErr('api.ragflow.datasetUpdateFailed', { status: 500 })
  }
}

export const PUT = withAudit(_PUT)

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)
    const { id } = await params
    const body = (await request.json()) as {
      type?: KnowledgeBaseType
      thresholdOverride?: number | null
      enabled?: boolean
      navigation?: Record<string, unknown>
    }
    const metadata = await updateKnowledgeMetadata(knowledgeMetadataRepository, id, body)
    if (!metadata) return apiErr('api.common.notFound', { status: 404 })
    return apiOk(metadata)
  } catch (error) {
    if (error instanceof ImmutableKnowledgeBaseTypeError || error instanceof InvalidKnowledgeThresholdError) {
      return apiErr('api.common.invalidParams', {
        status: 400,
        extra: { code: error.code },
      })
    }
    logger.error('Failed to update knowledge base metadata', error)
    return apiErr('api.ragflow.datasetUpdateFailed', { status: 500 })
  }
}

export const PATCH = withAudit(_PATCH)
