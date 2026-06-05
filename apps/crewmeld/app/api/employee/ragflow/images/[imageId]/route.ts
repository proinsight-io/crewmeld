import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { getImage, loadRagflowConfig, RagflowClientError } from '@/lib/ragflow'

const logger = createLogger('RagflowImageProxy')

/**
 * GET /api/employee/ragflow/images/[imageId]
 *
 * Proxies a RagFlow chunk image to the browser. RagFlow's image endpoint
 * requires the API key, so we cannot expose it directly — markdown images in
 * KB-derived chunks point at this route instead, and we stream the bytes
 * through with same-origin auth.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { imageId } = await params
    if (!imageId) {
      return apiErr('api.ragflow.imageMissingId', { status: 400 })
    }

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
