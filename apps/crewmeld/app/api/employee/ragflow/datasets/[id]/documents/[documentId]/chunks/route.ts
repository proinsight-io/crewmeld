import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { getDocumentChunks, loadRagflowConfig, RagflowClientError } from '@/lib/ragflow'
import { attachImagesToChunks } from '@/lib/knowledge/document-images/matching'
import {
  findBoundDocumentImages,
  findPendingImageBindingGeneration,
} from '@/lib/knowledge/document-images/repository'
import { enqueueDocumentImageBinding } from '@/lib/knowledge/document-images/binding-queue'

const logger = createLogger('RagflowChunksAPI')

function isParseComplete(run: unknown): boolean {
  return run === 3 || run === '3' || run === 'DONE' || run === 'done' || run === 'COMPLETED'
}

/**
 * GET /api/employee/ragflow/datasets/[id]/documents/[documentId]/chunks
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> }
) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id, documentId } = await params
    const url = new URL(request.url)
    const page = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : undefined
    const pageSize = url.searchParams.get('page_size')
      ? Number(url.searchParams.get('page_size'))
      : undefined
    const keywords = url.searchParams.get('keywords') ?? undefined

    const config = await loadRagflowConfig()
    const data = await getDocumentChunks(config, id, documentId, { page, pageSize, keywords })
    const images = await findBoundDocumentImages((data.chunks ?? []).map((chunk) => chunk.id))

    if (isParseComplete(data.doc?.run)) {
      const generation = await findPendingImageBindingGeneration(documentId)
      if (generation !== null) {
        try {
          await enqueueDocumentImageBinding(id, documentId, generation)
        } catch (error) {
          logger.warn('Failed to enqueue pending document image binding repair', error)
        }
      }
    }

    return apiOk({ ...data, chunks: attachImagesToChunks(data.chunks ?? [], images) })
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to fetch chunk list', error)
    return apiErr('api.ragflow.chunkListFailed', { status: 500 })
  }
}
