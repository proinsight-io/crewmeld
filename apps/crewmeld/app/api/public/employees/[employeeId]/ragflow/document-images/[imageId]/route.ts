import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { getEmployeeRagflowDatasetIds } from '@/lib/conversation/knowledge-query'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { findDocumentImageById } from '@/lib/knowledge/document-images/repository'

/**
 * GET /api/public/employees/[employeeId]/ragflow/document-images/[imageId]
 *
 * Public-API counterpart of /api/employee/ragflow/document-images/[imageId]
 * — serves the same docx-extracted images, authenticated with the employee
 * API key instead of an admin session. Unlike the admin route, this also
 * checks the image's dataset is actually bound to the requesting employee,
 * since the API key here is scoped to one published employee rather than a
 * platform-wide admin permission.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ employeeId: string; imageId: string }> }
) {
  const { employeeId, imageId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
    })

  const image = imageId ? await findDocumentImageById(imageId) : null
  if (!image) return apiErr('api.ragflow.imageFetchFailed', { status: 404 })

  const boundDatasetIds = await getEmployeeRagflowDatasetIds(employeeId)
  if (!boundDatasetIds.includes(image.datasetId)) {
    return apiErr('api.ragflow.imageFetchFailed', { status: 404 })
  }

  return new Response(Buffer.from(image.contentBase64, 'base64'), {
    headers: {
      'Content-Type': image.mimeType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
