/**
 * GET /api/employee/dev-studio/sessions/:sessionId/run-test/log
 *
 * Retrieves the last N lines of the service log from a retained sandbox.
 * Sandboxes are retained for 5 minutes after a failed test run so the
 * developer can inspect logs for debugging.
 *
 * Query params:
 *  - `sandboxId` (required) — the sandbox id from the SSE `done` event
 *  - `lines` (optional, default 200) — number of tail lines to return
 *
 * Errors:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 400 — missing sandboxId query param
 *  - 410 — sandbox retain window has expired (key absent from Redis)
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getRedisClient } from '@/lib/core/config/redis'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** Redis key prefix matching sandbox-loader's markRetained. */
const RETAIN_KEY_PREFIX = 'dev-studio:retain:'

/** Default service log path inside the sandbox. */
const SERVICE_LOG_PATH = '/tmp/dev-studio-service.log'

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  /* ── Auth guard ─────────────────────────────────────────────── */
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  /* ── Query params ───────────────────────────────────────────── */
  const url = new URL(req.url)
  const sandboxId = url.searchParams.get('sandboxId')
  if (!sandboxId) {
    return Response.json(
      { error: 'missing-sandbox-id', detail: 'sandboxId query parameter is required.', retryable: false },
      { status: 400 }
    )
  }

  const linesParam = url.searchParams.get('lines')
  const lines = linesParam ? Math.max(1, Math.min(Number.parseInt(linesParam, 10) || 200, 10000)) : 200

  /* ── Check retain window ────────────────────────────────────── */
  const redis = getRedisClient()
  if (redis) {
    const retainValue = await redis.get(`${RETAIN_KEY_PREFIX}${sandboxId}`)
    if (retainValue === null) {
      return Response.json(
        { error: 'retain-expired', detail: 'Sandbox retain window has expired or sandbox was not retained.', retryable: false },
        { status: 410 }
      )
    }
  }

  /* ── Tail the log ───────────────────────────────────────────── */
  const client = getOpenSandboxClient()
  const result = await client.exec({
    sandboxId,
    cmd: ['bash', '-c', `tail -n ${lines} ${SERVICE_LOG_PATH} 2>/dev/null || echo "(log file not found)"`],
    timeoutMs: 10_000,
  })

  return new Response(result.stdout, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
