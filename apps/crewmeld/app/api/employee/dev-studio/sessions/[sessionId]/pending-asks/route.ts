/**
 * GET /api/employee/dev-studio/sessions/:sessionId/pending-asks
 *
 * Returns the session's still-pending HITL `<ask>` prompts so the dev-studio
 * chat can re-surface them as answerable inline cards after a reopen.
 *
 * Why this exists: streamed `<ask>` tags are stripped from persisted assistant
 * text (and the Claude SDK does not re-emit them on resume), so a question the
 * operator backgrounded mid-flight would otherwise be invisible when they come
 * back — answerable only from the corner NotificationCenter. With the corner
 * reduced to notify-only, the workbench must own answering, so it needs the
 * pending asks to rebuild the cards.
 *
 * The stored `payload` IS the full `Ask` object (see chat route's
 * `persistPendingAction(..., ask)`); we re-stamp `askId` / `type` from the row
 * columns so the returned shape is authoritative even for legacy rows.
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user (no info leak)
 *  - 200 — `{ asks: Ask[] }` (possibly empty)
 */
import { db, toolDevPendingActions } from '@crewmeld/db'
import { and, asc, eq } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import type { Ask } from '@/lib/dev-studio/ask-extractor'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

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

  const rows = await db
    .select({
      askId: toolDevPendingActions.askId,
      type: toolDevPendingActions.type,
      payload: toolDevPendingActions.payload,
    })
    .from(toolDevPendingActions)
    .where(
      and(
        eq(toolDevPendingActions.sessionId, sessionId),
        eq(toolDevPendingActions.status, 'pending')
      )
    )
    .orderBy(asc(toolDevPendingActions.createdAt))

  const asks = rows.map((r) => {
    const body =
      r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {}
    // Row columns win over the (redundant) payload copy so askId/type are
    // always authoritative.
    return { ...body, askId: r.askId, type: r.type } as Ask
  })

  return Response.json({ asks })
}
