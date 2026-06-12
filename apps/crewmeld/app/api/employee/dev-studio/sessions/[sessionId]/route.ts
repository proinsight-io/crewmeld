/**
 * Single-session resource endpoints.
 *
 * - GET: return the session row when owned by the caller.
 * - PATCH: update narrow whitelist of session metadata (`rightPanelVisible`,
 *   `connectionId`). Strict schema rejects unknown fields with 400.
 * - DELETE: physically delete the session and its related records
 *   (messages, pending actions). If the session has a linked tool (`toolId`
 *   is non-null), workspace files are PRESERVED (they belong to the tool).
 *   If `toolId` is null (new-tool stage), workspace + claude state dirs are
 *   deleted as well. Container is best-effort destroyed.
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { purgeSession } from '@/lib/dev-studio/session-teardown'

/**
 * PATCH /sessions/:sessionId body schema.
 *
 * Intentionally narrow: only fields the UI is allowed to mutate land here.
 * Lifecycle transitions live in dedicated endpoints (adopt, rehydrate, DELETE).
 * Adding a new editable field is a deliberate API change — extend the schema.
 */
const PatchSchema = z
  .object({
    rightPanelVisible: z.boolean().optional(),
    // System connection bound to the session, or null to clear. The studio
    // surfaces the connection's CONN_* env vars to the model and the test-run
    // sandbox injects the resolved values.
    connectionId: z.string().nullable().optional(),
  })
  .strict()

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * GET /api/employee/dev-studio/sessions/:sessionId
 *
 * Returns `{ session }` for the row identified by `:sessionId` when:
 *  - the caller is authenticated; and
 *  - the row exists; and
 *  - the row is owned by the caller.
 *
 * Cross-user lookups return 404 (not 403) to avoid leaking session existence.
 */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }
  return Response.json({ session })
}

/**
 * PATCH /api/employee/dev-studio/sessions/:sessionId
 *
 * Updates whitelisted UI-state fields on the session row. Returns the patched
 * row. Same auth + ownership rules as GET; unknown body fields produce 400.
 */
export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
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
  const parsed = PatchSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const updated = await sessionStore.update(sessionId, parsed.data)
  return Response.json({ session: updated })
}

/**
 * DELETE /api/employee/dev-studio/sessions/:sessionId
 *
 * Physically deletes the session and all related DB records (messages, pending
 * actions, then the session row itself). Container is best-effort destroyed.
 *
 * Workspace protection:
 *  - If `toolId` is non-null (session linked to a tool), workspace + claude
 *    state directories are PRESERVED — they belong to the tool and may be
 *    reused by future iteration sessions.
 *  - If `toolId` is null (new-tool stage, never adopted), workspace + claude
 *    state directories are deleted from the host filesystem.
 *
 * Returns 204 on success; 401/404 on auth/ownership failure.
 */
export async function DELETE(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  await purgeSession(session)

  return new Response(null, { status: 204 })
}
