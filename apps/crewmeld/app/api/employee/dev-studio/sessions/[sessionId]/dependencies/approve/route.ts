/**
 * POST /api/employee/dev-studio/sessions/:sessionId/dependencies/approve
 *
 * Approves the tool's current dependency set for this session. Approval is a
 * pure acknowledgement — it records the manifest's current
 * `dependencies.{libraries,domains}` into `session.approvedDependencies` so the
 * "needs review" signal (manifest − approved − global-presets) clears and the
 * adopt gate releases. It does NOT rewrite the manifest: editing the actual
 * dependency list happens in the test-panel dependency editor, and globally
 * preset packages are handled automatically (never need approval).
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 409 — no manifest yet (the AI must create it before deps can be approved)
 *  - 200 — { approved } echoing the persisted manifest deps
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { readManifestFromSession } from '@/lib/dev-studio/manifest-reader'
import { sessionStore } from '@/lib/dev-studio/session-store'

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

  const manifest = await readManifestFromSession(sessionId).catch(() => null)
  if (!manifest) {
    return new Response(
      JSON.stringify({ error: 'no-manifest', detail: 'manifest does not exist', retryable: false }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  }

  const approved = {
    libraries: manifest.dependencies.libraries,
    domains: manifest.dependencies.domains,
  }
  await sessionStore.update(sessionId, { approvedDependencies: approved })
  return Response.json({ approved })
}
