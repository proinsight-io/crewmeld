/**
 * PUT /api/employee/dev-studio/sessions/:sessionId/dependencies/libraries
 *
 * Save endpoint for the test-panel dependency editor. Replaces the session
 * manifest's `dependencies.libraries` with the supplied list (mirrored into
 * requirements.txt by {@link setManifestLibraries}). Optional: the tool runs
 * fine off the AI-authored manifest without ever calling this — it is only used
 * when the operator edits the dependency list.
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 409 — no manifest yet (the AI must create it first)
 *  - 400 — bad body shape
 *  - 200 — { libraries } echoing the persisted list
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { setManifestLibraries } from '@/lib/dev-studio/manifest-reader'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const LibrariesSchema = z.object({ libraries: z.array(z.string()) }).strict()

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = LibrariesSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  try {
    const next = await setManifestLibraries(sessionId, parsed.data.libraries)
    return Response.json({ libraries: next.dependencies.libraries })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CONFLICT')) {
      return new Response(
        JSON.stringify({ error: 'no-manifest', detail: err.message, retryable: false }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    }
    throw err
  }
}
