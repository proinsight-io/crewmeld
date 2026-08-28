import { conversationMessages, conversations, db, digitalEmployees, user } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { apiErr, apiOk } from '@/lib/api/response'
import { createConversationGreeting } from '@/lib/conversation/greeting'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'
import { resolveWebIdentity } from '@/lib/identity/web-identity'

const Body = z.object({
  externalUserId: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/** Create a conversation for a published digital employee. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
      extra: { code: auth.reason.toUpperCase() },
    })
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  const [employee] = await db
    .select({ id: digitalEmployees.id, config: digitalEmployees.config })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)
  if (!employee) return apiErr('api.employee.notFound', { status: 404 })

  const [boundUser] = auth.principal.userId
    ? await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, auth.principal.userId))
        .limit(1)
    : []
  const identity = auth.principal.userId ? await resolveWebIdentity(auth.principal.userId) : null
  const greeting = createConversationGreeting(
    employee.config,
    boundUser ?? { id: auth.principal.actorId, name: null, email: null },
    identity
  )
  const id = crypto.randomUUID()
  const now = new Date()
  const greetingMessage = greeting
    ? {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: greeting,
        metadata: { source: 'greeting' },
        createdAt: now.toISOString(),
      }
    : null
  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id,
      employeeId,
      userId: auth.principal.actorId,
      workspaceId: employeeId,
      channel: 'api',
      messageCount: greetingMessage ? 1 : 0,
      lastMessageAt: greetingMessage ? now : null,
      metadata: {
        ...parsed.data.metadata,
        apiKeyId: auth.principal.keyId,
        externalUserId: parsed.data.externalUserId,
      },
    })
    if (greetingMessage)
      await tx.insert(conversationMessages).values({
        id: greetingMessage.id,
        conversationId: id,
        role: greetingMessage.role,
        content: greetingMessage.content,
        metadata: greetingMessage.metadata,
        createdAt: now,
      })
  })
  return apiOk(
    { id, employeeId, channel: 'api', status: 'active', greetingMessage },
    { status: 201 }
  )
}
