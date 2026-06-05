import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  createDataset,
  DEFAULT_PARSER_CONFIG,
  deleteDataset,
  listDatasets,
  loadRagflowConfig,
  RagflowClientError,
  RagflowErrorType,
} from '@/lib/ragflow'

const logger = createLogger('RagflowDatasetsAPI')

/**
 * GET /api/employee/ragflow/datasets — Knowledge base list
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const url = new URL(request.url)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')))
    const name = url.searchParams.get('name') ?? undefined

    const config = await loadRagflowConfig()
    const datasets = await listDatasets(config, { page, pageSize, name })

    return apiOk(datasets)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      if (error.type === RagflowErrorType.ConfigMissing) {
        return apiErr('api.ragflow.notConfigured', {
          status: 503,
          extra: { code: 'CONFIG_MISSING', detail: error.message },
        })
      }
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to fetch knowledge base list', error)
    return apiErr('api.ragflow.datasetListFailed', { status: 500 })
  }
}

/**
 * POST /api/employee/ragflow/datasets — Create knowledge base
 */
async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('knowledge:create')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = (await request.json()) as { name?: string; description?: string }
    if (!body.name?.trim()) {
      return apiErr('api.ragflow.datasetNameRequired', { status: 400 })
    }

    const config = await loadRagflowConfig()
    // Apply the project-wide default parser_config (auto_keywords +
    // auto_questions + layout_recognize) so every new dataset benefits from
    // LLM-assisted chunk tagging at ingestion time.
    const dataset = await createDataset(config, {
      name: body.name.trim(),
      description: body.description?.trim(),
      parser_config: DEFAULT_PARSER_CONFIG,
    })

    return apiOk(dataset, { status: 201 })
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to create knowledge base', error)
    return apiErr('api.ragflow.datasetCreateFailed', { status: 500 })
  }
}

/**
 * DELETE /api/employee/ragflow/datasets — Delete knowledge base
 */
async function _DELETE(request: NextRequest) {
  try {
    const auth = await requirePermission('knowledge:delete')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = (await request.json()) as { id?: string }
    if (!body.id) {
      return apiErr('api.ragflow.datasetIdRequired', { status: 400 })
    }

    const config = await loadRagflowConfig()
    await deleteDataset(config, body.id)

    return apiOk(null)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to delete knowledge base', error)
    return apiErr('api.ragflow.datasetDeleteFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
export const DELETE = withAudit(_DELETE)
