import { db, toolDevMessages } from '@crewmeld/db'
import { asc, eq } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * GET /api/employee/dev-studio/sessions/:sessionId/messages
 *
 * Returns the persisted message timeline for a session, ordered by sequence.
 * Used by the frontend to restore chat history when switching between sessions.
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

  const rows = await db
    .select()
    .from(toolDevMessages)
    .where(eq(toolDevMessages.sessionId, sessionId))
    .orderBy(asc(toolDevMessages.sequence))

  return Response.json({ messages: rows })
}
