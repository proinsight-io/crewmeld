import { db, toolInstanceApiKeys, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { getServicePublicBaseUrl, haveSameHostname } from '@/lib/core/utils/urls'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { hashApiKey } from '@/lib/tools/api-key-service'
import { selectServiceReplica } from '@/lib/tools/service-replica-selector'
import type { ServiceSpec } from '@/app/(employee)/skills/types'

const logger = createLogger('ServiceGateway')
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface PublishedService {
  id: string
  publishedAsService: boolean
  authMode: string
  visibility: string
  customDomain: string | null
  deploy: unknown
  serviceSpec: ServiceSpec
}

function copyRequestHeaders(headers: Headers): Headers {
  const result = new Headers()
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'x-api-key'
    ) {
      return
    }
    if (lower === 'cookie') {
      const applicationCookies = value
        .split(';')
        .map((cookie) => cookie.trim())
        .filter((cookie) => !cookie.startsWith('cm_service_replica='))
        .join('; ')
      if (applicationCookies) result.set(name, applicationCookies)
      return
    }
    result.set(name, value)
  })
  return result
}

function copyResponseHeaders(headers: Headers): Headers {
  const result = new Headers()
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length') return
    result.append(name, value)
  })
  return result
}

function preferredReplica(request: Request): number | undefined {
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(/(?:^|;\s*)cm_service_replica=(\d+)/)
  if (!match) return undefined
  const ordinal = Number(match[1])
  return Number.isInteger(ordinal) ? ordinal : undefined
}

function appendRelativePath(endpoint: string, relativePath: string, search: string): string {
  const url = new URL(endpoint)
  const basePath = url.pathname.replace(/\/$/, '')
  const suffix = relativePath ? `/${relativePath.replace(/^\/+/, '')}` : ''
  url.pathname = `${basePath}${suffix}` || '/'
  url.search = search
  return url.toString()
}

async function authorize(request: Request, instanceId: string, authMode: string): Promise<boolean> {
  if (authMode === 'anonymous') return true
  const apiKey = request.headers.get('X-API-Key')
  if (!apiKey) return false
  const [record] = await db
    .select({ id: toolInstanceApiKeys.id })
    .from(toolInstanceApiKeys)
    .where(
      and(
        eq(toolInstanceApiKeys.instanceId, instanceId),
        eq(toolInstanceApiKeys.hashedKey, hashApiKey(apiKey)),
        eq(toolInstanceApiKeys.active, true)
      )
    )
    .limit(1)
  if (!record) return false
  void db
    .update(toolInstanceApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(toolInstanceApiKeys.id, record.id))
  return true
}

export async function loadPublishedService(instanceId: string): Promise<PublishedService | null> {
  const [row] = await db
    .select({
      id: toolInstances.id,
      publishedAsService: toolInstances.publishedAsService,
      authMode: toolInstances.serviceAuthMode,
      visibility: toolInstances.serviceVisibility,
      customDomain: toolInstances.serviceDomain,
      deploy: toolInstances.deploy,
      serviceSpec: tools.serviceSpec,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, instanceId))
    .limit(1)
  if (!row) return null
  return {
    ...row,
    serviceSpec: (row.serviceSpec as ServiceSpec | null) ?? {
      type: 'json',
      port: 3000,
      path: '/',
      method: 'POST',
    },
  }
}

export async function resolvePublishedServiceByDomain(
  hostname: string
): Promise<PublishedService | null> {
  const normalized = hostname.split(':')[0]?.toLowerCase() ?? ''
  const [row] = await db
    .select({ id: toolInstances.id })
    .from(toolInstances)
    .where(
      and(
        eq(toolInstances.serviceDomain, normalized),
        eq(toolInstances.serviceVisibility, 'public'),
        eq(toolInstances.publishedAsService, true)
      )
    )
    .limit(1)
  return row ? loadPublishedService(row.id) : null
}

/** Transparently proxy one HTTP or SSE request to a healthy service replica. */
export async function proxyPublishedService(
  request: Request,
  service: PublishedService,
  relativePath: string
): Promise<Response> {
  if (!service.publishedAsService) {
    return Response.json({ success: false, error: 'Service is not published.' }, { status: 403 })
  }
  const publicBaseUrl = getServicePublicBaseUrl()
  const requestOrigin =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.url
  const isSharedPublicRequest =
    publicBaseUrl !== undefined && haveSameHostname(requestOrigin, publicBaseUrl)
  if (isSharedPublicRequest && service.visibility !== 'public') {
    return Response.json(
      { success: false, error: 'Service is not publicly available.' },
      { status: 403 }
    )
  }
  if (!(await authorize(request, service.id, service.authMode))) {
    return Response.json({ success: false, error: 'Invalid or missing API key.' }, { status: 401 })
  }
  if (service.serviceSpec.type === 'json' && relativePath) {
    return Response.json(
      { success: false, error: 'JSON services do not expose subpaths.' },
      { status: 404 }
    )
  }

  const replica = await selectServiceReplica(service.id, preferredReplica(request))
  if (!replica) {
    return Response.json({ success: false, error: 'No healthy service replica.' }, { status: 503 })
  }

  const incoming = new URL(request.url)
  const target = appendRelativePath(replica.endpoint, relativePath, incoming.search)
  const headers = copyRequestHeaders(request.headers)
  Object.entries(getOpenSandboxClient().proxyHeaders()).forEach(([name, value]) => {
    headers.set(name, value)
  })

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      // Node fetch requires duplex for a streamed request body.
      ...(request.body ? { duplex: 'half' as const } : {}),
    })
  } catch (error) {
    logger.error('Service proxy request failed', {
      instanceId: service.id,
      replica: replica.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Service proxy failed.' }, { status: 502 })
  }

  const responseHeaders = copyResponseHeaders(upstream.headers)
  responseHeaders.set('X-CrewMeld-Service-Replica', replica.id)
  responseHeaders.append(
    'Set-Cookie',
    `cm_service_replica=${replica.ordinal}; Path=/; HttpOnly; SameSite=Lax`
  )
  if (service.serviceSpec.type === 'sse') {
    responseHeaders.set('Cache-Control', 'no-cache, no-transform')
    responseHeaders.set('X-Accel-Buffering', 'no')
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
