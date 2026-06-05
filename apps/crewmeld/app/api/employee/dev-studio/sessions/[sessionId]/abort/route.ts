/**
 * POST /api/employee/dev-studio/sessions/:sessionId/abort
 *
 * Forwards an abort request to claude-code-webui inside the container.
 * Semantically equivalent to pressing ESC in the claude CLI: interrupts the
 * current tool execution; sessionId is persisted by webui so the next /chat
 * call resumes the same conversation.
 *
 * Sub-spec B: migrated off the in-process `sessionRegistry` onto the
 * DB-backed `sessionStore` so /abort, /chat and the rest of the session
 * surface share a single source of truth. Auth + ownership rules match
 * sibling routes (cross-user returns 404; container-less sessions return 409
 * to prompt the caller to /rehydrate).
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { AbortRequestSchema } from '@/lib/dev-studio/schemas'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response(JSON.stringify({ error: 'session-expired', retryable: false }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (!session.activeContainerId) {
    return new Response(
      JSON.stringify({
        error: 'no-active-container',
        detail: 'Session has no live container to abort.',
        retryable: false,
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  }

  const raw = await req.json().catch(() => null)
  const parsed = AbortRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'bad-request', retryable: false }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'config-missing', detail: String(e), retryable: false }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  let webuiUrl: string
  try {
    webuiUrl = await client.getEndpoint(session.activeContainerId, 8080)
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'sandbox-unreachable', detail: String(e), retryable: true }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  const upstream = await fetch(
    `${webuiUrl}/api/abort/${encodeURIComponent(parsed.data.requestId)}`,
    { method: 'POST', headers: client.proxyHeaders() }
  ).catch(() => null)

  if (!upstream) {
    return new Response(JSON.stringify({ error: 'sandbox-unreachable', retryable: true }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Pass through status (200 success, 404 means webui already cleaned up).
  return new Response(null, { status: upstream.status })
}
