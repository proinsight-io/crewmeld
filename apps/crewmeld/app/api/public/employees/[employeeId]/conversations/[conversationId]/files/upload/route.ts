/**
 * POST /api/public/employees/[employeeId]/conversations/[conversationId]/files/upload
 *
 * External-channel counterpart of /api/employee/conversations/files/upload — same
 * storage path (uploadConversationFile), but authenticated via the published
 * employee API key instead of a staff session, for use by external H5/channel
 * clients that never have a CrewMeld login.
 *
 * Accepts FormData { file }. Returns FileAttachment { key, name, size, mimeType }.
 */

import { conversations, db } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'
import { apiErr, apiOk } from '@/lib/api/response'
import { uploadConversationFile } from '@/lib/conversation/file-storage'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'

const MAX_FILE_SIZE = 50 * 1024 * 1024

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

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.employeeId, employeeId),
        eq(conversations.userId, auth.principal.actorId)
      )
    )
    .limit(1)
  if (!conversation) return apiErr('api.common.notFound', { status: 404 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) return apiErr('api.files.notProvided', { status: 400 })
  if (file.size > MAX_FILE_SIZE) {
    return apiErr('api.files.tooLarge', {
      status: 413,
      params: { maxMb: MAX_FILE_SIZE / 1024 / 1024 },
    })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const attachment = await uploadConversationFile(
    conversationId,
    file.name,
    buffer,
    file.type || 'application/octet-stream'
  )

  return apiOk(attachment, { extra: { file: attachment } })
}
