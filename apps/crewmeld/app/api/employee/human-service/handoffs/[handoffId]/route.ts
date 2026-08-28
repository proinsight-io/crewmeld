import { conversations, db, humanHandoffs } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { apiErr, apiOk } from '@/lib/api/response'
import { getSession } from '@/lib/auth'
import { canSupportEmployee } from '@/lib/human-service/authorization'
import { resolveHandoffAction } from '@/lib/human-service/handoff-ownership'

const Action = z.object({
  action: z.enum(['claim', 'assign', 'close']),
  assigneeId: z.string().min(1).optional(),
})
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ handoffId: string }> }
) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const { handoffId } = await params
  const parsed = Action.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  const [row] = await db
    .select({ handoff: humanHandoffs, employeeId: conversations.employeeId })
    .from(humanHandoffs)
    .innerJoin(conversations, eq(conversations.id, humanHandoffs.conversationId))
    .where(eq(humanHandoffs.id, handoffId))
    .limit(1)
  if (!row) return apiErr('api.conversation.notFound', { status: 404 })
  if (!(await canSupportEmployee(row.employeeId, session.user.id)))
    return apiErr('api.common.forbidden', { status: 403 })
  if (parsed.data.action === 'assign' && !parsed.data.assigneeId)
    return apiErr('api.common.invalidParams', { status: 400 })
  const next = resolveHandoffAction(
    {
      status: row.handoff.status,
      assigneeId: row.handoff.assigneeId,
      claimedByUserId: row.handoff.claimedByUserId,
    },
    parsed.data.action === 'assign'
      ? { action: 'assign', assigneeId: parsed.data.assigneeId! }
      : { action: parsed.data.action },
    session.user.id
  )
  const [updated] = await db
    .update(humanHandoffs)
    .set({
      ...next,
      updatedAt: new Date(),
    })
    .where(and(eq(humanHandoffs.id, handoffId), eq(humanHandoffs.status, row.handoff.status)))
    .returning()
  return updated ? apiOk(updated) : apiErr('api.common.conflict', { status: 409 })
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handoffId: string }> }
) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const { handoffId } = await params
  const [row] = await db
    .select()
    .from(humanHandoffs)
    .where(eq(humanHandoffs.id, handoffId))
    .limit(1)
  return row ? apiOk(row) : apiErr('api.conversation.notFound', { status: 404 })
}
