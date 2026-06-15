/**
 * Shared download handler for `tool-execution/[execId]/files/...` GET routes.
 *
 * Two Next.js route shapes share this implementation:
 *   - `files/[filename]/route.ts`   — single-segment, used by the test-result
 *     panel's download links (`/files/output.png`)
 *   - `files/[...path]/route.ts`    — catch-all, used by callers that need
 *     nested layouts (`/files/sub/dir/foo.png`)
 *
 * Without this helper the single-segment URL hits the upload-only
 * `[filename]/route.ts` and returns 405, because Next.js' route precedence
 * picks the more specific dynamic segment over the catch-all.
 *
 * NFS-aware retry (spec §9.3 + §F26):
 *   - First fs.stat ENOENT → sleep 300 ms → retry once.
 *   - Mitigates Windows NFS client attribute-cache TTL: a file just written
 *     on the sandbox side may appear missing for 1–3 s on the BFF side until
 *     the negative-cache entry expires.
 *
 * Range support: a single open-ended or bounded byte range becomes a 206
 * with Content-Range. Invalid syntax → 416. Multi-range bytes=a-b,c-d is
 * intentionally unsupported (boundary marshaling adds complexity that callers
 * have never needed).
 */
import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { NextRequest } from 'next/server'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { paths } from '@/lib/dev-studio/paths'
import { authorizeExecution } from '@/lib/dev-studio/tool-execution-auth'

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
}

const DEFAULT_MIME = 'application/octet-stream'

function getMime(target: string): string {
  const ext = path.extname(target).toLowerCase()
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function statWithRetry(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // 300 ms covers the typical Windows-NFS-client attribute-cache TTL.
  await sleep(300)
  try {
    return await fs.stat(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Resolve a file inside the per-execution toolIo dir and stream it back.
 *
 * `segments` is the URL path components AFTER `/files/`. Both the
 * single-segment and catch-all routes pass an array — single-segment routes
 * pass `[filename]`, catch-all routes pass the full path[].
 */
export async function serveToolExecutionFile(
  req: NextRequest,
  execId: string,
  segments: readonly string[]
): Promise<Response> {
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const authorized = await authorizeExecution(execId, auth.userId)
  if (!authorized) {
    return new Response('Forbidden', { status: 403 })
  }

  // Files now live under the sop-files dir keyed by sopExecId. In test mode
  // the dev-studio run-test executionId IS the sopExecId; in production
  // each SOP allocates one. The URL parameter name stays `execId` for back-
  // compat — callers don't care about the underlying storage path shift.
  const ioDir = paths.sopFiles.forBff(execId)
  const requestPath = segments.map(decodeURIComponent).join('/')
  const target = paths.safeResolve(ioDir, requestPath)
  if (!target) {
    return Response.json({ error: 'path-traversal' }, { status: 400 })
  }

  const stat = await statWithRetry(target)
  if (!stat || !stat.isFile()) {
    return new Response('Not Found', { status: 404 })
  }

  const mime = getMime(target)
  const fileSize = stat.size
  const range = req.headers.get('range')

  if (range) {
    const m = range.match(/^bytes=(\d+)-(\d+)?$/)
    if (!m) return new Response('Invalid Range', { status: 416 })
    const start = Number.parseInt(m[1], 10)
    const end = m[2] ? Number.parseInt(m[2], 10) : fileSize - 1
    if (start >= fileSize || end >= fileSize || start > end) {
      return new Response('Range Not Satisfiable', { status: 416 })
    }
    const stream = createReadStream(target, { start, end })
    return new Response(Readable.toWeb(stream) as never, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  const stream = createReadStream(target)
  return new Response(Readable.toWeb(stream) as never, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
    },
  })
}
