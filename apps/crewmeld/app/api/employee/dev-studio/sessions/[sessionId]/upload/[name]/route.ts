/**
 * POST /api/employee/dev-studio/sessions/[sessionId]/upload/[name]
 *
 * Receives a user-uploaded reference file (code, spec, sample data, etc.) and
 * lands it under `<workspace>/upload/<name>` where the sandbox sees it as
 * `/root/workspace/upload/<name>`. Files in this directory are exposed to the
 * AI on the operator's next chat turn via a queued system note so the model
 * can treat them as inputs when generating the tool.
 *
 * Durability sequence mirrors the io upload route: stream → fsync → stat
 * verify, so a Windows NFS-client write is fully on the Ubuntu server before
 * the AI is told the file exists.
 *
 * Same-name re-upload overwrites (Node createWriteStream defaults to `'w'`).
 * Filename rules mirror the io route (no slashes, no leading dot, ≤ 200 chars).
 *
 * Auth: caller must own the session. Cross-user returns 404 (no info leak).
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NextRequest } from 'next/server'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { sessionStore } from '@/lib/dev-studio/session-store'

const MAX_UPLOAD_MB = Number(process.env.CREWMELD_DEV_STUDIO_IO_MAX_MB ?? '100')
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024

/** Same filename grammar as the io route — keeps the AI's mental model
 *  consistent across all upload surfaces. */
const FILENAME_RE = /^[^/\\.][^/\\]{0,199}$/

/** Subdirectory under `<workspace>` where user uploads land. The sandbox
 *  reads them at `/root/workspace/<UPLOAD_SUBDIR>/<name>`. */
const UPLOAD_SUBDIR = 'upload'

interface RouteContext {
  params: Promise<{ sessionId: string; name: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId, name } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const filename = decodeURIComponent(name)
  if (filename === '..' || !FILENAME_RE.test(filename)) {
    return Response.json({ error: 'invalid-filename' }, { status: 400 })
  }

  const uploadDir = path.join(paths.sessionWorkspace.forBff(sessionId), UPLOAD_SUBDIR)
  const target = path.join(uploadDir, filename)
  await fs.mkdir(uploadDir, { recursive: true })

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

  const writeStream = createWriteStream(target)
  const nodeStream = Readable.fromWeb(file.stream() as never)
  await pipeline(nodeStream, writeStream)

  const syncHandle = await fs.open(target, 'r+')
  try {
    await syncHandle.sync()
  } finally {
    await syncHandle.close()
  }

  const stat = await fs.stat(target)
  if (stat.size !== file.size) {
    return Response.json(
      { error: 'write-verify-failed', expected: file.size, actual: stat.size },
      { status: 502 }
    )
  }

  sessionStore.queueUploadNotice(sessionId, { filename, size: stat.size })

  return Response.json({ filename, size: stat.size })
}

/**
 * DELETE the uploaded file. Idempotent — a missing file returns
 * `{ deleted: false }` rather than 404 so concurrent UI clicks don't error.
 *
 * Restricted to filenames matching {@link FILENAME_RE}, which means the
 * caller cannot escape the upload dir via traversal. The route only ever
 * targets `<workspace>/upload/<name>`; deleting anything outside this
 * subdir would require a different endpoint.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId, name } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const filename = decodeURIComponent(name)
  if (filename === '..' || !FILENAME_RE.test(filename)) {
    return Response.json({ error: 'invalid-filename' }, { status: 400 })
  }

  const target = path.join(paths.sessionWorkspace.forBff(sessionId), UPLOAD_SUBDIR, filename)
  try {
    await fs.unlink(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ deleted: false })
    }
    throw e
  }
  return Response.json({ deleted: true })
}
