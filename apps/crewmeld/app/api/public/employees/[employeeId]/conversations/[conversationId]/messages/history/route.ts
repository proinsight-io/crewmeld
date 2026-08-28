import { conversationMessages, conversations, db } from '@crewmeld/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { apiErr, apiOk } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'

interface StoredMessageMetadata {
  files?: unknown
}

/**
 * POST /api/public/employees/[employeeId]/conversations/[conversationId]/messages/history
 *
 * Returns customer-visible message history for a conversation. Deliberately
 * POST rather than GET (see the sibling conversations/list route for why),
 * and deliberately separate from the sibling POST /messages route, which
 * sends a new message rather than reading history.
 *
 * Only user/assistant messages are returned — tool-call and system
 * messages are internal and must not leak to the customer-facing client.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ employeeId: string; conversationId: string }> }
) {
  const { employeeId, conversationId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
    })

  const externalUserId = new URL(request.url).searchParams.get('externalUserId')
  if (!externalUserId) return apiErr('api.common.invalidParams', { status: 400 })

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.employeeId, employeeId),
        eq(conversations.userId, auth.principal.actorId),
        sql`${conversations.metadata} ->> 'externalUserId' = ${externalUserId}`
      )
    )
    .limit(1)
  if (!conversation) return apiErr('api.common.notFound', { status: 404 })

  const rows = await db
    .select({
      id: conversationMessages.id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      metadata: conversationMessages.metadata,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        inArray(conversationMessages.role, ['user', 'assistant'])
      )
    )
    .orderBy(asc(conversationMessages.createdAt))
    .limit(200)

  return apiOk(
    rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content ?? '',
      createdAt: row.createdAt.toISOString(),
      files: (row.metadata as StoredMessageMetadata | null)?.files ?? undefined,
    }))
  )
}
