/**
 * POST + GET /api/employee/tool-execution/[execId]/files/[filename]
 *
 * **POST** — upload a single file as input/output payload for a tool
 * execution. Bodies are multipart/form-data with one `file` field. The file
 * is written to the per-execution IO directory derived from
 * {@link paths.toolIo.forBff}.
 *
 * **GET** — download the named file from the per-execution IO directory.
 * Delegates to {@link serveToolExecutionFile} so this single-segment route
 * and the sibling `[...path]` catch-all share one implementation
 * (auth, NFS-aware retry, Range, MIME). Without this GET handler the
 * Next.js single-segment-wins precedence routes `/files/output.png` here
 * and returns 405 — which broke the result-panel download links.
 *
 * NFS-aware durability sequence for POST (spec §9.2 + §F26):
 *   1. open(file, 'w') → pipeline(req.body → file) → fsync → close
 *   2. fs.stat(file) — verify on-disk size matches uploaded size
 *
 * The fsync step flushes the Windows NFS client buffer to the Ubuntu server,
 * so when the sandbox-side path is read seconds later the content is already
 * visible (without the 5 s attribute-cache TTL window swallowing it).
 *
 * Authorization (§9.5):
 *   - Session cookie via {@link getCurrentUserRole}.
 *   - {@link authorizeExecution}: execId must belong to a session/instance
 *     owned by the caller. Cross-user access returns 403.
 *
 * Filename safety (POST only — GET delegates to safeResolve):
 *   - Path segment param is URI-decoded.
 *   - Regex `^[^/\\.][^/\\]{0,199}$` blocks `/`, `\\`, leading `.`, and the
 *     `..` traversal sentinel (length cap 200).
 *
 * Status codes:
 *   - 200 — uploaded with `{ filename, size, path }` (POST) or file body (GET)
 *   - 206 — partial body for Range (GET)
 *   - 400 — invalid filename / missing `file` form field / path traversal
 *   - 401 — unauthenticated
 *   - 403 — execId not owned by caller
 *   - 404 — file missing (GET, after NFS retry)
 *   - 413 — body exceeds `CREWMELD_TOOL_IO_MAX_UPLOAD_MB` (POST, default 100)
 *   - 416 — invalid / unsatisfiable Range (GET)
 *   - 502 — post-write size mismatch (POST, NFS write loss)
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NextRequest } from 'next/server'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { authorizeExecution } from '@/lib/dev-studio/tool-execution-auth'
import { serveToolExecutionFile } from '@/lib/dev-studio/tool-execution-download'

const MAX_UPLOAD_MB = Number(process.env.CREWMELD_TOOL_IO_MAX_UPLOAD_MB ?? '100')
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024
const FILENAME_RE = /^[^/\\.][^/\\]{0,199}$/

interface RouteContext {
  params: Promise<{ execId: string; filename: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { execId, filename: rawFilename } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const authorized = await authorizeExecution(execId, auth.userId)
  if (!authorized) {
    return new Response('Forbidden', { status: 403 })
  }

  const filename = decodeURIComponent(rawFilename)
  if (filename === '..' || !FILENAME_RE.test(filename)) {
    return Response.json({ error: 'invalid-filename' }, { status: 400 })
  }

  // Uploads now land in the sop-files dir keyed by sopExecId; in dev-studio
  // test mode execId IS the sopExecId so the URL still works for callers.
  const ioDir = paths.sopFiles.forBff(execId)
  await fs.mkdir(ioDir, { recursive: true })

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

  const target = path.join(ioDir, filename)
  // Pipe the upload body into a path-keyed write stream first (no FileHandle
  // sharing — pipeline + handle.createWriteStream races the FD close). After
  // the stream resolves, reopen the file via FileHandle just long enough to
  // fsync it. fsync flushes Windows NFS client buffers so the next read on
  // the sandbox side sees fully-written bytes.
  const writeStream = createWriteStream(target)
  // Readable.fromWeb requires a Web ReadableStream — File.stream() returns a
  // Web stream regardless of runtime. Cast through `never` because the SDK
  // typings declare `import('stream/web').ReadableStream` which the DOM lib
  // doesn't structurally match in Bun/Node mixed envs.
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

  return Response.json({ filename, size: stat.size, path: filename })
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { execId, filename } = await ctx.params
  // Delegate to the shared helper. We pass the raw URL segment (still
  // URI-encoded) because the helper itself decodes — matching how the
  // `[...path]` catch-all hands segments off. Filename validation is
  // covered by the helper's `paths.safeResolve` traversal check.
  return serveToolExecutionFile(req, execId, [filename])
}
