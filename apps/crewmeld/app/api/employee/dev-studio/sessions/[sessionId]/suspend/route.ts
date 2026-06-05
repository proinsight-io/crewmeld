/**
 * POST /api/employee/dev-studio/sessions/:sessionId/suspend
 *
 * Implicit-background teardown, fired when the operator navigates away from the
 * dev studio (the dialog/hook unmounts) rather than explicitly discarding.
 *
 * The distinction from DELETE matters: navigating away must NOT destroy work.
 * Behavior:
 *  - **Empty, never-adopted session** (no `user` messages AND no linked tool):
 *    purge it entirely — there is nothing worth keeping and leaving it `active`
 *    would clutter the "open dev studio" resume entry. Same teardown as DELETE.
 *  - **Otherwise**: suspend — destroy the container best-effort but keep the
 *    row `active` and preserve the workspace, so the operator can rehydrate it
 *    later from the same host directories.
 *
 * A non-active session (already adopted/archived) is a no-op. Returns 204 in
 * all success cases. Tolerates being invoked via `fetch(..., { keepalive: true
 * })` during page unload.
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { purgeSession } from '@/lib/dev-studio/session-teardown'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export async function POST(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  // Only `active` sessions carry a live container worth suspending. Terminal
  // rows (adopted/archived) are left exactly as they are.
  if (session.status !== 'active') {
    return new Response(null, { status: 204 })
  }

  // Empty + never-adopted → purge (no work to keep, and an empty active row
  // would wrongly keep the entry button on "open dev studio"). Otherwise the
  // session holds real work: preserve it and only drop the container.
  const hasWork = session.toolId != null || (await sessionStore.hasUserMessages(sessionId))
  if (!hasWork) {
    await purgeSession(session)
    return new Response(null, { status: 204 })
  }

  if (session.activeContainerId) {
    try {
      const env = getDevStudioEnv()
      const client = new OpenSandboxClient({
        serverUrl: env.OPENSANDBOX_SERVER_URL,
        apiKey: env.OPENSANDBOX_API_KEY,
      })
      await client.destroy(session.activeContainerId)
    } catch {
      // Best-effort; the OpenSandbox TTL is the backstop.
    }
  }
  await sessionStore.suspend(sessionId)
  return new Response(null, { status: 204 })
}
