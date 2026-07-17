/**
 * POST /api/employee/conversations/files/upload — Conversation file upload (stored directly in MinIO)
 *
 * Accepts FormData { file, conversationId? }
 * Returns FileAttachment { key, name, size, mimeType }
 */

import type { NextRequest } from 'next/server'
import { apiErr, apiOk } from '@/lib/api/response'
import { getSession } from '@/lib/auth'
import { uploadConversationFile } from '@/lib/conversation/file-storage'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) {
    return apiErr('api.common.unauthorized', { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return apiErr('api.files.notProvided', { status: 400 })
  }

  // File size limit: 50MB
  const MAX_FILE_SIZE = 50 * 1024 * 1024
  if (file.size > MAX_FILE_SIZE) {
    return apiErr('api.files.tooLarge', {
      status: 413,
      params: { maxMb: MAX_FILE_SIZE / 1024 / 1024 },
    })
  }

  // conversationId is required: the client creates the conversation before
  // uploading so the file lands in the conversation's NFS conv-io dir. There is
  // no `user-<id>` pre-conversation MinIO fallback anymore.
  const conversationId = formData.get('conversationId') as string | null
  if (!conversationId) {
    return apiErr('api.files.notProvided', { status: 400 })
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
