import { conversations, db, digitalEmployees, humanHandoffs } from '@crewmeld/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiErr, apiOk } from '@/lib/api/response'
import { getSession } from '@/lib/auth'
import { canSupportEmployee } from '@/lib/human-service/authorization'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) return apiErr('api.common.unauthorized', { status: 401 })
  const url = new URL(request.url)
  const employeeId = url.searchParams.get('employeeId')
  const status = url.searchParams.get('status')
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))
  const conditions = [ne(humanHandoffs.status, 'resolved')]
  if (employeeId) conditions.push(eq(conversations.employeeId, employeeId))
  if (status === 'open' || status === 'assigned' || status === 'resolved')
    conditions.push(eq(humanHandoffs.status, status))
  const rows = await db
    .select({
      id: humanHandoffs.id,
      conversationId: humanHandoffs.conversationId,
      assigneeId: humanHandoffs.assigneeId,
      status: humanHandoffs.status,
      createdAt: humanHandoffs.createdAt,
      updatedAt: humanHandoffs.updatedAt,
      employeeId: conversations.employeeId,
      employeeName: digitalEmployees.name,
      customerUserId: conversations.userId,
      channel: conversations.channel,
      title: conversations.title,
      messageCount: conversations.messageCount,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(humanHandoffs)
    .innerJoin(conversations, eq(conversations.id, humanHandoffs.conversationId))
    .leftJoin(digitalEmployees, eq(digitalEmployees.id, conversations.employeeId))
    .where(and(...conditions))
    .orderBy(desc(humanHandoffs.updatedAt))
    .limit(limit)
  const allowed = []
  for (const row of rows) {
    if (await canSupportEmployee(row.employeeId, session.user.id)) allowed.push(row)
  }
  return apiOk(allowed)
}
