/**
 * GET /api/employee/tool-execution/[execId]/files
 *
 * List flat files written to the per-execution IO directory. Returns
 * `{ files: Array<{ name, size, mtime }> }` sorted by `name` for stable
 * client rendering.
 *
 * If the IO directory does not exist (no upload yet, or it has been deleted),
 * returns 200 with an empty array — the panel renders the empty affordance
 * rather than a 404.
 *
 * Authorization: same `authorizeExecution` check as upload/download.
 *
 * Status codes:
 *   - 200 — file list (possibly empty)
 *   - 401 — unauthenticated
 *   - 403 — execId not owned by caller
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { authorizeExecution } from '@/lib/dev-studio/tool-execution-auth'

interface RouteContext {
  params: Promise<{ execId: string }>
}

interface FileEntry {
  name: string
  size: number
  mtime: string
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { execId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const authorized = await authorizeExecution(execId, auth.userId)
  if (!authorized) {
    return new Response('Forbidden', { status: 403 })
  }

  // Files moved from per-execId toolIo to per-sopExecId sop-files; in
  // dev-studio test mode execId IS the sopExecId. The URL contract holds.
  const ioDir = paths.sopFiles.forBff(execId)
  let entries: string[]
  try {
    entries = await fs.readdir(ioDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ files: [] })
    }
    throw e
  }

  const files: FileEntry[] = []
  for (const name of entries) {
    const stat = await fs.stat(path.join(ioDir, name))
    if (stat.isFile()) {
      files.push({ name, size: stat.size, mtime: stat.mtime.toISOString() })
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return Response.json({ files })
}
