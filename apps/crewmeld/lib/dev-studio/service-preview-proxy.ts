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

const BLOCKED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'host',
  'content-length',
  'cookie',
  'open-sandbox-api-key',
])

const BLOCKED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'set-cookie',
  'content-security-policy',
  'x-frame-options',
])

const PREVIEW_CSP = [
  'sandbox allow-scripts allow-forms allow-modals allow-downloads',
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  'connect-src * data: blob:',
  "frame-ancestors 'self'",
].join('; ')

function pathSegments(value: string): string[] {
  return value.split('/').filter(Boolean)
}

/** Build an upstream URL without allowing catch-all path traversal. */
export function buildPreviewUpstreamUrl(
  endpoint: string,
  servicePath: string,
  relativePath: string[],
  search: string
): string {
  const url = new URL(endpoint)
  const segments = [
    ...pathSegments(url.pathname),
    ...pathSegments(servicePath),
    ...relativePath.map((segment) => encodeURIComponent(segment)),
  ]
  url.pathname = `/${segments.join('/')}${relativePath.length === 0 ? '/' : ''}`
  url.search = search
  url.hash = ''
  return url.toString()
}

/** Copy browser headers while injecting platform credentials server-side only. */
export function copyPreviewRequestHeaders(
  incoming: Headers,
  proxyHeaders: Record<string, string>
): Headers {
  const result = new Headers()
  const connectionHeaders = new Set(
    (incoming.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  )
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (BLOCKED_REQUEST_HEADERS.has(lower) || connectionHeaders.has(lower)) return
    result.append(name, value)
  })
  for (const [name, value] of Object.entries(proxyHeaders)) result.set(name, value)
  return result
}

function rewriteLocation(
  location: string,
  previewPrefix: string,
  upstreamRequestUrl: string,
  upstreamBaseUrl: string
): string {
  let resolved: URL
  try {
    resolved = new URL(location, upstreamRequestUrl)
  } catch {
    return location
  }
  const base = new URL(upstreamBaseUrl)
  if (resolved.origin !== base.origin) return location

  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  let relative: string
  if (resolved.pathname.startsWith(basePath)) {
    relative = resolved.pathname.slice(basePath.length)
  } else {
    const baseSegments = pathSegments(base.pathname)
    const resolvedSegments = pathSegments(resolved.pathname)
    let sharedSegments = 0
    while (
      sharedSegments < baseSegments.length &&
      baseSegments[sharedSegments] === resolvedSegments[sharedSegments]
    ) {
      sharedSegments += 1
    }
    relative = resolvedSegments.slice(sharedSegments).join('/')
  }
  const prefix = previewPrefix.endsWith('/') ? previewPrefix : `${previewPrefix}/`
  return `${prefix}${relative}${resolved.search}${resolved.hash}`
}

/** Sanitize upstream response headers for an opaque, short-lived iframe. */
export function buildPreviewResponseHeaders(
  upstream: Headers,
  previewPrefix: string,
  upstreamRequestUrl: string,
  upstreamBaseUrl: string
): Headers {
  const result = new Headers()
  const connectionHeaders = new Set(
    (upstream.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  )
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (BLOCKED_RESPONSE_HEADERS.has(lower) || connectionHeaders.has(lower)) return
    if (lower === 'location') {
      result.set(name, rewriteLocation(value, previewPrefix, upstreamRequestUrl, upstreamBaseUrl))
      return
    }
    result.append(name, value)
  })
  result.set('Cache-Control', 'no-store')
  result.set('Referrer-Policy', 'no-referrer')
  result.set('X-Content-Type-Options', 'nosniff')
  result.set('X-Frame-Options', 'SAMEORIGIN')
  result.set('Content-Security-Policy', PREVIEW_CSP)
  result.set('Access-Control-Allow-Origin', '*')
  result.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS')
  result.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key')
  return result
}
