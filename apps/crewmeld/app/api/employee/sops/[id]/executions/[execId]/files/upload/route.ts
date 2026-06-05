/**
 * POST /api/employee/sops/[id]/executions/[execId]/files/upload
 *
 * Uploads a user-provided file into a SOP execution's workspace under
 * `sop/{execId}/inputs/`. When the executing tool Pod has needsFileMount
 * enabled and an rclone sidecar attached, the file appears at
 * `/workspace/inputs/{name}` from the tool's view.
 *
 * Request:  FormData { file: File }
 * Response: { key, name, size, mimeType }
 */

import { db } from '@crewmeld/db'
import { sopExecutions } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { uploadSopInput } from '@/lib/sop/file-workspace'

const logger = createLogger('API:Sops:Files:Upload')

/** 50 MB hard cap, mirrors the conversation upload route. */
const MAX_FILE_SIZE = 50 * 1024 * 1024

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; execId: string }> }
) {
  try {
    const auth = await requirePermission('sop:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id, execId } = await params

    // Verify the execution exists and belongs to this SOP definition.
    // Guards against arbitrary execId in the URL writing into MinIO.
    const [execution] = await db
      .select({ id: sopExecutions.id })
      .from(sopExecutions)
      .where(and(eq(sopExecutions.id, execId), eq(sopExecutions.sopDefinitionId, id)))
      .limit(1)
    if (!execution) {
      return apiErr('api.sop.executionNotFound', { status: 404 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return apiErr('api.files.notProvided', { status: 400 })
    }
    if (file.size > MAX_FILE_SIZE) {
      return apiErr('api.files.tooLarge', {
        status: 413,
        params: { maxMb: MAX_FILE_SIZE / 1024 / 1024 },
      })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const attachment = await uploadSopInput(
      execId,
      file.name,
      buffer,
      file.type || 'application/octet-stream'
    )

    return apiOk(attachment, { extra: { file: attachment } })
  } catch (error) {
    logger.error('SOP file upload failed', error)
    return apiErr('api.files.uploadFailed', { status: 500 })
  }
}
