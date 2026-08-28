import { createLogger } from '@crewmeld/logger'
import JSZip from 'jszip'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { downloadDocument, getDataset, getDocument, loadRagflowConfig, RagflowClientError } from '@/lib/ragflow'

const logger = createLogger('RagflowDocumentExportAPI')

/** De-duplicate a filename against names already used in the zip by appending " (n)" before the extension. */
function uniqueZipName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 2
  let candidate = `${base} (${n})${ext}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${base} (${n})${ext}`
  }
  used.add(candidate)
  return candidate
}

/**
 * POST /api/employee/ragflow/datasets/[id]/documents/export — Batch-download
 * selected documents as a single zip archive.
 * Body: { documentIds: string[] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const body = (await request.json()) as { documentIds?: string[] }
    const documentIds = body.documentIds

    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return apiErr('api.ragflow.exportDocumentIdsRequired', { status: 400 })
    }

    const config = await loadRagflowConfig()
    const zip = new JSZip()
    const usedNames = new Set<string>()

    for (const documentId of documentIds) {
      const [doc, upstream] = await Promise.all([
        getDocument(config, id, documentId),
        downloadDocument(config, id, documentId),
      ])
      const bytes = await upstream.arrayBuffer()
      zip.file(uniqueZipName(doc.name, usedNames), bytes)
    }

    let zipName = 'documents-export.zip'
    try {
      const dataset = await getDataset(config, id)
      if (dataset.name) zipName = `${dataset.name}.zip`
    } catch {
      // Non-fatal — fall back to the generic name.
    }

    const zipBytes = await zip.generateAsync({ type: 'nodebuffer' })
    return new Response(zipBytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      },
    })
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Failed to export documents', error)
    return apiErr('api.ragflow.exportFailed', { status: 500 })
  }
}
