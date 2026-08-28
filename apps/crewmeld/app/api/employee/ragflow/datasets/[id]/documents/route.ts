import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  listDocuments,
  loadRagflowConfig,
  parseDocuments,
  RagflowClientError,
  uploadDocument,
} from '@/lib/ragflow'
import { knowledgeMetadataRepository } from '@/lib/ragflow/knowledge-metadata-repository'
import { extractDocxAnchoredImages } from '@/lib/knowledge/document-images/docx-extractor'
import { replaceDocumentImages } from '@/lib/knowledge/document-images/repository'
import { enqueueDocumentImageBinding } from '@/lib/knowledge/document-images/binding-queue'

const logger = createLogger('RagflowDocumentsAPI')

/**
 * GET /api/employee/ragflow/datasets/[id]/documents — Document list
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const url = new URL(request.url)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')))

    const config = await loadRagflowConfig()
    const documents = await listDocuments(config, id, { page, pageSize })

    return apiOk(documents)
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to fetch document list', error)
    return apiErr('api.ragflow.documentListFailed', { status: 500 })
  }
}

/**
 * POST /api/employee/ragflow/datasets/[id]/documents — Upload document
 */
async function _POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const [metadata] = await knowledgeMetadataRepository.findByDatasetIds([id])
    if (metadata?.type === 'qa') {
      return apiErr('api.ragflow.qaDirectUploadForbidden', {
        status: 409,
        extra: { code: 'QA_DIRECT_UPLOAD_FORBIDDEN' },
      })
    }
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const fileUrl = formData.get('fileUrl') as string | null
    const filename = formData.get('filename') as string | null

    const url = new URL(request.url)
    const parseOnUpload = url.searchParams.get('parse') !== 'false'

    const config = await loadRagflowConfig()
    let docs: Awaited<ReturnType<typeof uploadDocument>>
    let uploadBytes: Uint8Array | null = null
    let uploadFilename = ''
    const documentsWithImages = new Set<string>()

    if (file) {
      uploadBytes = new Uint8Array(await file.arrayBuffer())
      uploadFilename = file.name
      docs = await uploadDocument(config, id, file, file.name)
    } else if (fileUrl && filename) {
      const fileRes = await fetch(fileUrl)
      if (!fileRes.ok) {
        return apiErr('api.ragflow.documentDownloadFailed', {
          status: 400,
          extra: { detail: `HTTP ${fileRes.status}` },
        })
      }
      const blob = await fileRes.blob()
      uploadBytes = new Uint8Array(await blob.arrayBuffer())
      uploadFilename = filename
      docs = await uploadDocument(config, id, blob, filename)
    } else {
      return apiErr('api.ragflow.documentFileMissing', { status: 400 })
    }

    if (uploadBytes && uploadFilename.toLowerCase().endsWith('.docx')) {
      try {
        const images = await extractDocxAnchoredImages(uploadBytes)
        for (const doc of docs ?? []) {
          if (doc.id) {
            await replaceDocumentImages(id, doc.id, images)
            if (images.length > 0) documentsWithImages.add(doc.id)
          }
        }
      } catch (imageError) {
        logger.warn('DOCX image extraction failed; continuing with text-only document', {
          datasetId: id,
          error: imageError instanceof Error ? imageError.message : String(imageError),
        })
      }
    }

    // Auto-trigger parsing based on the parse query parameter
    if (parseOnUpload) {
      const docIds = (docs ?? []).map((d) => d.id).filter(Boolean)
      if (docIds.length > 0) {
        try {
          await parseDocuments(config, id, docIds)
          for (const documentId of documentsWithImages) {
            try {
              const queued = await enqueueDocumentImageBinding(id, documentId, 1)
              if (!queued) {
                logger.warn('Document image binding remains pending because Redis is unavailable', {
                  datasetId: id,
                  documentId,
                })
              }
            } catch (queueError) {
              logger.warn('Document image binding enqueue failed; pending state will be recovered', {
                datasetId: id,
                documentId,
                error: queueError instanceof Error ? queueError.message : String(queueError),
              })
            }
          }
          logger.info(
            `Auto-triggered parsing after upload: dataset=${id}, docs=${docIds.join(',')}`
          )
        } catch (parseError) {
          logger.warn('Auto-trigger document parsing failed (documents uploaded)', parseError)
        }
      }
    }

    return apiOk(docs, { status: 201 })
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to upload document', error)
    return apiErr('api.ragflow.documentUploadFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
