import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { getImage, loadRagflowConfig, RagflowClientError } from '@/lib/ragflow'

const logger = createLogger('PublicRagflowImageProxy')

/**
 * GET /api/public/employees/[employeeId]/ragflow/images/[imageId]
 *
 * Public-API counterpart of /api/employee/ragflow/images/[imageId] — same
 * RagFlow chunk-image proxy, authenticated with the employee API key instead
 * of an admin session, for conversations served over the public API (e.g.
 * the H5 client) where no admin session exists.
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
  if (!imageId) return apiErr('api.ragflow.imageMissingId', { status: 400 })

  try {
    const config = await loadRagflowConfig()
    const upstream = await getImage(config, imageId)

    if (!upstream.ok) {
      logger.warn('Upstream image fetch failed', { imageId, status: upstream.status })
      return apiErr('api.ragflow.imageFetchFailed', {
        status: upstream.status === 404 ? 404 : 502,
      })
    }

    const headers = new Headers()
    const contentType = upstream.headers.get('content-type') ?? 'image/png'
    headers.set('Content-Type', contentType)
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) headers.set('Content-Length', contentLength)
    headers.set('Cache-Control', 'private, max-age=3600')

    return new Response(upstream.body, { status: 200, headers })
  } catch (error) {
    if (error instanceof RagflowClientError) {
      return apiErr('api.ragflow.upstreamError', { status: 502, extra: { detail: error.message } })
    }
    logger.error('Image proxy failed', error)
    return apiErr('api.ragflow.imageFetchFailed', { status: 500 })
  }
}
