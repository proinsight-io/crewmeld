/**
 * GET /api/employee/dev-studio/sessions/[sessionId]/io
 *
 * List the flat files the operator has uploaded for run-test under
 * `<bff-root>/io/session/<Y>/<M>/<D>/<sessionId>/`. The date layer is derived
 * from `session.createdAt` so the same session always resolves to the same
 * directory regardless of when the list is requested.
 *
 * Returns `{ files: Array<{ name, size, mtime }> }` sorted by `name`.
 *
 * Missing directory → 200 with an empty list (fresh session with no uploads).
 *
 * Authorization: caller must own the session (same 404-on-other-user pattern
 * as sibling routes — no info leak).
 *
 * Status codes:
 *   - 200 — listing (possibly empty)
 *   - 401 — unauthenticated
 *   - 404 — session missing or not owned by caller
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

interface FileEntry {
  name: string
  size: number
  mtime: string
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const ioDir = paths.sessionIo.forBff(sessionId, session.createdAt)

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
