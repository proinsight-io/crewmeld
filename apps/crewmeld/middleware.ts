import { type NextRequest, NextResponse } from 'next/server'
import { getEnv } from '@/lib/core/config/env'
import { getBaseUrl } from '@/lib/core/utils/urls'

/**
 * Resolves the Access-Control-Allow-Origin value for a request based on the
 * ALLOWED_ORIGINS config. Three modes:
 * - '*'           → allow any origin, but without credentials (browser rule:
 *                    '*' and Allow-Credentials: true are mutually exclusive)
 * - comma list    → echo the request origin if it is in the list, with credentials
 * - empty / unset → fall back to the canonical base URL, with credentials
 *
 * @param canonical - A thunk that returns the canonical base URL. It is only
 *   evaluated in the empty/unset fallback branch, so callers that configure
 *   ALLOWED_ORIGINS as '*' or a whitelist never pay the cost of evaluating it
 *   (and a misconfigured NEXT_PUBLIC_APP_URL will not throw on the hot path).
 */
export function resolveCorsOrigin(
  requestOrigin: string | null,
  allowed: string | undefined,
  canonical: () => string
): { origin: string | null; credentials: boolean } {
  const trimmed = allowed?.trim()

  if (trimmed === '*') {
    return { origin: '*', credentials: false }
  }

  if (!trimmed) {
    return { origin: canonical(), credentials: true }
  }

  const whitelist = trimmed
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  if (requestOrigin && whitelist.includes(requestOrigin)) {
    return { origin: requestOrigin, credentials: true }
  }

  return { origin: null, credentials: false }
}

/** Apply the resolved CORS headers onto a response. */
function applyCorsHeaders(res: NextResponse, requestOrigin: string | null): NextResponse {
  const { origin, credentials } = resolveCorsOrigin(
    requestOrigin,
    getEnv('ALLOWED_ORIGINS'),
    getBaseUrl
  )

  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin)
    if (credentials) {
      res.headers.set('Access-Control-Allow-Credentials', 'true')
    }
    res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE')
    res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, X-Internal-Secret'
    )
  }

  return res
}

/**
 * Paths under /api that set their own unconditional public CORS (Allow-Origin: *)
 * in next.config.ts. The middleware must not also set CORS headers on them, or the
 * response would carry two Access-Control-Allow-Origin values (invalid CORS).
 */
const PUBLIC_CORS_PATHS: RegExp[] = [
  /^\/api\/form(?:\/|$)/,
  /^\/api\/workflows\/[^/]+\/execute$/,
]

export function isPublicCorsPath(pathname: string): boolean {
  return PUBLIC_CORS_PATHS.some((re) => re.test(pathname))
}

export function middleware(req: NextRequest): NextResponse {
  // Endpoints with their own unconditional public CORS in next.config are excluded
  // here to avoid double-setting Access-Control-Allow-Origin.
  if (isPublicCorsPath(req.nextUrl.pathname)) {
    return NextResponse.next()
  }

  const requestOrigin = req.headers.get('origin')

  // Preflight: short-circuit with 204 + CORS headers.
  if (req.method === 'OPTIONS') {
    return applyCorsHeaders(new NextResponse(null, { status: 204 }), requestOrigin)
  }

  return applyCorsHeaders(NextResponse.next(), requestOrigin)
}

export const config = {
  matcher: ['/api/:path*'],
}
