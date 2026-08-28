import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  deleteDocument,
  downloadDocument,
  getDocument,
  loadRagflowConfig,
  RagflowClientError,
  renameDocument,
  updateDocumentEnabled,
} from '@/lib/ragflow'
import { deleteDocumentImages } from '@/lib/knowledge/document-images/repository'

const logger = createLogger('RagflowDocumentDetailAPI')

/**
 * GET /api/employee/ragflow/datasets/[id]/documents/[documentId] — Document detail or download
 * When ?download=true, proxies and returns file content
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
    const config = await loadRagflowConfig()

    if (new URL(request.url).searchParams.get('download') === 'true') {
      const upstream = await downloadDocument(config, id, documentId)
      const doc = await getDocument(config, id, documentId)
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
      const body = await upstream.arrayBuffer()
      return new NextResponse(body, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
        },
      })
    }

    const doc = await getDocument(config, id, documentId)
    return apiOk(doc)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to fetch document detail', error)
    return apiErr('api.ragflow.documentDetailFailed', { status: 500 })
  }
}

/**
 * PUT /api/employee/ragflow/datasets/[id]/documents/[documentId] — Update document enabled status
 */
async function _PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> }
) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id, documentId } = await params
    const body = (await request.json()) as { enabled?: boolean; name?: string }
    const config = await loadRagflowConfig()
    if (body.name !== undefined) {
      await renameDocument(config, id, documentId, body.name)
    } else if (body.enabled !== undefined) {
      await updateDocumentEnabled(config, id, documentId, body.enabled)
    }

    return apiOk(null)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to update document enabled status', error)
    return apiErr('api.ragflow.documentUpdateStatusFailed', { status: 500 })
  }
}

/**
 * DELETE /api/employee/ragflow/datasets/[id]/documents/[documentId] — Delete document
 */
async function _DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> }
) {
  try {
    const auth = await requirePermission('knowledge:delete')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id, documentId } = await params
    const config = await loadRagflowConfig()
    await deleteDocument(config, id, documentId)
    try {
      await deleteDocumentImages(documentId)
    } catch (cleanupError) {
      logger.warn('Document deleted but extracted image cleanup failed', {
        documentId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }

    return apiOk(null)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      const status = error.type === 'NOT_FOUND' ? 404 : 502
      return apiErr('api.ragflow.upstreamError', { status, extra: { detail: error.message } })
    }
    logger.error('Failed to delete document', error)
    return apiErr('api.ragflow.documentDeleteFailed', { status: 500 })
  }
}

export const PUT = withAudit(_PUT)
export const DELETE = withAudit(_DELETE)
