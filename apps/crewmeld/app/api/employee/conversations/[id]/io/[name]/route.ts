/**
 * Per-file routes for the production conversation-scoped NFS staging area:
 *   POST   /api/employee/conversations/[id]/io/[name]
 *   GET    /api/employee/conversations/[id]/io/[name]
 *   DELETE /api/employee/conversations/[id]/io/[name]
 *
 * URL slug is `[id]` to match the sibling `conversations/[id]/...` routes
 * (Next.js requires the same dynamic param name at every depth).
 *
 * Files live under `<bff-root>/io/conversation/<Y>/<M>/<D>/<id>/`. Date
 * layer derives from the conversation row's `createdAt`. SOP startup
 * copies the contents into `sop-files/<sopExecId>/` so the dev-studio
 * tools mounted at `/root/io` can read them.
 *
 * Mirrors the dev-studio sessions/<sid>/io/<name> route — auth model,
 * filename guard, NFS-aware fsync, and the per-verb logic are all parallel
 * so the two routes can evolve together. The only differences are auth
 * (session cookie + db conversations row) and the date-layer source.
 *
 * Auth: caller must own the conversation. Cross-user is 404 (no info
 * leak); existing-but-missing-file case is also 404 to keep the
 * path-traversal regex from leaking name existence.
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { conversations, db } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import { paths } from '@/lib/dev-studio/paths'

const MAX_UPLOAD_MB = Number(process.env.CREWMELD_CONV_IO_MAX_MB ?? '100')
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024

/**
 * Allowed filename: 1-200 chars, no slashes / backslashes, no leading dot
 * (blocks `..`, hidden files, and absolute paths). Same as the
 * dev-studio session-io route's regex so AI-generated tools see consistent
 * filename rules across staging surfaces.
 */
const FILENAME_RE = /^[^/\\.][^/\\]{0,199}$/

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

const DEFAULT_MIME = 'application/octet-stream'

interface RouteContext {
  params: Promise<{ id: string; name: string }>
}

/**
 * Resolve `(convId, rawName, authUserId)` → `{ ioDir, target, filename }` or
 * a typed error. Centralizes auth + filename safety so each verb body stays
 * focused on its action.
 */
async function resolveTarget(
  convId: string,
  rawName: string,
  authUserId: string
): Promise<
  | { ok: true; ioDir: string; target: string; filename: string }
  | { ok: false; status: number; body: unknown }
> {
  const [conv] = await db
    .select({ id: conversations.id, userId: conversations.userId, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1)
  if (!conv || conv.userId !== authUserId) {
    return { ok: false, status: 404, body: 'Not Found' }
  }
  const filename = decodeURIComponent(rawName)
  if (filename === '..' || !FILENAME_RE.test(filename)) {
    return { ok: false, status: 400, body: { error: 'invalid-filename' } }
  }
  const ioDir = paths.conversationIo.forBff(convId, conv.createdAt)
  const target = path.join(ioDir, filename)
  return { ok: true, ioDir, target, filename }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { id: convId, name } = await ctx.params

  const session = await getSession()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(convId, name, session.user.id)
  if (!resolved.ok) {
    return typeof resolved.body === 'string'
      ? new Response(resolved.body, { status: resolved.status })
      : Response.json(resolved.body, { status: resolved.status })
  }

  await fs.mkdir(resolved.ioDir, { recursive: true })

  const formData = await req.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    return Response.json({ error: 'no-file-field' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: 'file-too-large', limitMB: MAX_UPLOAD_MB },
      { status: 413 }
    )
  }

  // Stream → fsync → verify. fsync flushes the Windows NFS client buffer
  // so a subsequent SOP-start seed sees the bytes immediately.
  const writeStream = createWriteStream(resolved.target)
  const nodeStream = Readable.fromWeb(file.stream() as never)
  await pipeline(nodeStream, writeStream)

  const syncHandle = await fs.open(resolved.target, 'r+')
  try {
    await syncHandle.sync()
  } finally {
    await syncHandle.close()
  }

  const stat = await fs.stat(resolved.target)
  if (stat.size !== file.size) {
    return Response.json(
      { error: 'write-verify-failed', expected: file.size, actual: stat.size },
      { status: 502 }
    )
  }

  return Response.json({ filename: resolved.filename, size: stat.size })
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { id: convId, name } = await ctx.params

  const session = await getSession()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(convId, name, session.user.id)
  if (!resolved.ok) {
    return typeof resolved.body === 'string'
      ? new Response(resolved.body, { status: resolved.status })
      : Response.json(resolved.body, { status: resolved.status })
  }

  let payload: Buffer
  try {
    payload = await fs.readFile(resolved.target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response('Not Found', { status: 404 })
    }
    throw e
  }

  const ext = path.extname(resolved.filename).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? DEFAULT_MIME
  return new Response(payload, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(payload.byteLength),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resolved.filename)}`,
    },
  })
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { id: convId, name } = await ctx.params

  const session = await getSession()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(convId, name, session.user.id)
  if (!resolved.ok) {
    return typeof resolved.body === 'string'
      ? new Response(resolved.body, { status: resolved.status })
      : Response.json(resolved.body, { status: resolved.status })
  }

  try {
    await fs.unlink(resolved.target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ deleted: false })
    }
    throw e
  }
  return Response.json({ deleted: true })
}
