/**
 * DELETE /api/employee/tool-execution/[execId]
 *
 * Remove the per-execution IO directory and everything it contains. Idempotent
 * — missing directory returns 204 (rm with `force: true`).
 *
 * Authorization: same `authorizeExecution` check as upload/download.
 *
 * Status codes:
 *   - 204 — deleted (no content)
 *   - 401 — unauthenticated
 *   - 403 — execId not owned by caller
 */
import fs from 'node:fs/promises'
import type { NextRequest } from 'next/server'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { authorizeExecution } from '@/lib/dev-studio/tool-execution-auth'

interface RouteContext {
  params: Promise<{ execId: string }>
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { execId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const authorized = await authorizeExecution(execId, auth.userId)
  if (!authorized) {
    return new Response('Forbidden', { status: 403 })
  }

  // Files under sop-files/<sopExecId>/ (flat); in test mode execId IS the
  // sopExecId so the URL contract still works.
  const ioDir = paths.sopFiles.forBff(execId)
  await fs.rm(ioDir, { recursive: true, force: true })
  return new Response(null, { status: 204 })
}
