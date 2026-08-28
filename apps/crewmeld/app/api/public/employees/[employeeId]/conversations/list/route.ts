import { conversations, db } from '@crewmeld/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { apiErr, apiOk } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'

/**
 * POST /api/public/employees/[employeeId]/conversations/list
 *
 * Lists conversations for the calling visitor. Deliberately POST rather
 * than GET, matching the method allowlist already used by the rest of the
 * public conversation API.
 *
 * `conversations.userId` alone cannot scope this to one visitor: every
 * anonymous visitor sharing an employee's API key resolves to the same
 * `auth.principal.actorId`. The actual per-visitor identity is the
 * `externalUserId` stashed in `conversations.metadata` at creation time
 * (see the sibling POST / route), so it must also be matched here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
    })

  const externalUserId = new URL(request.url).searchParams.get('externalUserId')
  if (!externalUserId) return apiErr('api.common.invalidParams', { status: 400 })

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      messageCount: conversations.messageCount,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.employeeId, employeeId),
        eq(conversations.userId, auth.principal.actorId),
        sql`${conversations.metadata} ->> 'externalUserId' = ${externalUserId}`
      )
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(50)

  return apiOk(
    rows.map((row) => ({
      ...row,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }))
  )
}
