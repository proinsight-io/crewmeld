import { createLogger } from '@crewmeld/logger'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import {
  buildPreviewResponseHeaders,
  buildPreviewUpstreamUrl,
  copyPreviewRequestHeaders,
} from '@/lib/dev-studio/service-preview-proxy'
import { getServicePreview } from '@/lib/dev-studio/service-preview-registry'

const logger = createLogger('ServicePreviewRoute')

interface RouteContext {
  params: Promise<{
    sessionId: string
    previewId: string
    path?: string[]
  }>
}

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { success: false, error },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    }
  )
}

async function handlePreviewRequest(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId, previewId, path = [] } = await context.params
  const preview = await getServicePreview(previewId)
  if (!preview) return errorResponse(410, 'Service preview has expired.')
  if (preview.sessionId !== sessionId) return errorResponse(404, 'Not Found')

  const client = getOpenSandboxClient()
  try {
    if (!(await client.isSandboxRunning(preview.sandboxId))) {
      return errorResponse(502, 'Service preview sandbox is not running.')
    }
  } catch (error) {
    logger.warn('Failed to inspect service preview sandbox', {
      sessionId,
      sandboxId: preview.sandboxId,
      error,
    })
    return errorResponse(502, 'Service preview sandbox is unavailable.')
  }

  let endpoint: string
  try {
    endpoint = await client.getEndpoint(preview.sandboxId, preview.port)
  } catch (error) {
    logger.warn('Failed to resolve service preview endpoint', {
      sessionId,
      sandboxId: preview.sandboxId,
      error,
    })
    return errorResponse(502, 'Service preview endpoint is unavailable.')
  }

  const incomingUrl = new URL(request.url)
  const upstreamBaseUrl = buildPreviewUpstreamUrl(endpoint, preview.servicePath, [], '')
  const upstreamUrl = buildPreviewUpstreamUrl(
    endpoint,
    preview.servicePath,
    path,
    incomingUrl.search
  )
  const headers = copyPreviewRequestHeaders(request.headers, client.proxyHeaders())
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
      ...(hasBody ? { duplex: 'half' as const } : {}),
    })
  } catch (error) {
    logger.warn('Service preview upstream request failed', {
      sessionId,
      sandboxId: preview.sandboxId,
      error,
    })
    return errorResponse(502, 'Service preview request failed.')
  }

  const previewPrefix = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/preview/${encodeURIComponent(previewId)}/`
  const responseHeaders = buildPreviewResponseHeaders(
    upstream.headers,
    previewPrefix,
    upstreamUrl,
    upstreamBaseUrl
  )
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const GET = handlePreviewRequest
export const POST = handlePreviewRequest
export const PUT = handlePreviewRequest
export const PATCH = handlePreviewRequest
export const DELETE = handlePreviewRequest
export const HEAD = handlePreviewRequest
export const OPTIONS = handlePreviewRequest
