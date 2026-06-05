/**
 * GET /api/employee/conversations/[id]/io
 *
 * List the user-uploaded files staged in the NFS conv-io directory at
 * `<bff-root>/io/conversation/<Y>/<M>/<D>/<id>/`. Date layer derives from
 * the conversation row's `createdAt` (caller doesn't pass it).
 *
 * This is the production-side counterpart of the dev-studio
 * `/sessions/<sid>/io` route; both routes expose the staging area that
 * later gets seeded into `sop-files/<sopExecId>/` when an SOP fires.
 *
 * Note the URL slug name is `[id]` — Next.js requires the same dynamic
 * param name at every depth of a route tree, and the sibling
 * `conversations/[id]/...` routes were here first.
 *
 * Returns `{ files: [{ name, size, mtime }] }` sorted by name. Missing
 * directory → 200 with empty list.
 *
 * Auth: session-cookie required; cross-user lookups return 404 (no info
 * leak), matching the dev-studio sessions/io convention.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { conversations, db } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { paths } from '@/lib/dev-studio/paths'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface FileEntry {
  name: string
  size: number
  mtime: string
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { id: convId } = await ctx.params

  const session = await getSession()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const [conv] = await db
    .select({ id: conversations.id, userId: conversations.userId, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1)
  if (!conv || conv.userId !== session.user.id) {
    return new Response('Not Found', { status: 404 })
  }

  const ioDir = paths.conversationIo.forBff(convId, conv.createdAt)
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
