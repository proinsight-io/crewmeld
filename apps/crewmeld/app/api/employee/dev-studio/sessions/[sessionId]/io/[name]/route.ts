/**
 * Per-file routes for the operator's persistent run-test inputs:
 *   POST   /api/employee/dev-studio/sessions/[sessionId]/io/[name]
 *   GET    /api/employee/dev-studio/sessions/[sessionId]/io/[name]
 *   DELETE /api/employee/dev-studio/sessions/[sessionId]/io/[name]
 *
 * Files live under `<bff-root>/io/session/<Y>/<M>/<D>/<sessionId>/`. The date
 * layer comes from `session.createdAt` so the path stays stable for the life
 * of the session.
 *
 * POST mirrors the NFS-aware durability sequence used by the
 * `/tool-execution/[execId]/files/[filename]` route: pipe → fsync → stat-verify
 * so a Windows NFS-client write is fully on the Ubuntu server before any
 * subsequent run-test reads it.
 *
 * GET streams the file back with an extension-derived MIME and the bare
 * filename in `Content-Disposition` so the browser keeps the original name.
 *
 * Auth: caller must own the session. Cross-user is 404 (no info leak); the
 * existing-but-missing-file case is also 404 to keep the path-traversal
 * regex from being a name-existence oracle.
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

/**
 * Allowed filename: 1-200 chars, no slashes / backslashes, no leading dot
 * (blocks `..`, hidden files, and absolute paths). Mirrors the tool-execution
 * convention so AI-generated tools see consistent filename rules across all
 * IO surfaces.
 */
const FILENAME_RE = /^[^/\\.][^/\\]{0,199}$/

/** Extension → MIME table. Kept small on purpose — anything unrecognized
 *  serves as octet-stream so the browser triggers a download. */
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
  params: Promise<{ sessionId: string; name: string }>
}

/** Resolve `(sessionId, rawName)` to `{ ioDir, target, filename }` or null/error.
 *  Centralizes auth + filename safety so each verb stays focused on its action. */
async function resolveTarget(
  sessionId: string,
  rawName: string,
  authUserId: string
): Promise<
  | { ok: true; ioDir: string; target: string; filename: string }
  | { ok: false; status: number; body: unknown }
> {
  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== authUserId) {
    return { ok: false, status: 404, body: 'Not Found' }
  }
  const filename = decodeURIComponent(rawName)
  if (filename === '..' || !FILENAME_RE.test(filename)) {
    return { ok: false, status: 400, body: { error: 'invalid-filename' } }
  }
  const ioDir = paths.sessionIo.forBff(sessionId, session.createdAt)
  const target = path.join(ioDir, filename)
  return { ok: true, ioDir, target, filename }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId, name } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(sessionId, name, auth.userId)
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

  // Stream → fsync → verify. See tool-execution upload route for rationale.
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
  const { sessionId, name } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(sessionId, name, auth.userId)
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
      // RFC 5987 — encode the filename so non-ASCII names round-trip safely.
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resolved.filename)}`,
    },
  })
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId, name } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const resolved = await resolveTarget(sessionId, name, auth.userId)
  if (!resolved.ok) {
    return typeof resolved.body === 'string'
      ? new Response(resolved.body, { status: resolved.status })
      : Response.json(resolved.body, { status: resolved.status })
  }

  try {
    await fs.unlink(resolved.target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Idempotent delete: already gone is success from the caller's POV.
      return Response.json({ deleted: false })
    }
    throw e
  }
  return Response.json({ deleted: true })
}
