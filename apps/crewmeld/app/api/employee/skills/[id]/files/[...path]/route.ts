/**
 * GET /api/employee/skills/:id/files/[...path]
 *
 * Streams a single file from a dev-studio tool's persistent code directory
 * (`paths.toolCode.forBff(id)`), read directly off the BFF-accessible NFS
 * volume. Mirrors the per-session file route's mime/size policy so the shared
 * preview dialog renders tool files exactly like session files.
 *
 * Path safety: the catch-all `[...path]` is rejected if any segment is `..`,
 * `.`, empty, absolute, or contains a backslash; the joined path is then
 * resolved via `safeResolveInTool`, which rejects anything escaping the tool
 * code root.
 *
 * Size policy (per mime kind, applied to the on-disk size):
 *  - text/* + application/json|xml|yaml : 1 MiB
 *  - image/*                            : 10 MiB
 *  - application/pdf                    : 20 MiB
 *  - everything else                    : unbounded
 *
 * When the file exceeds its cap, returns 412 with `{ size, mime, tooLarge }`
 * plus `x-file-size` so the UI can render a "too large" affordance.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { safeResolveInTool } from '@/lib/dev-studio/file-tree'

interface RouteContext {
  params: Promise<{ id: string; path: string[] }>
}

/**
 * Extension → mime mapping. Kept inline (and intentionally identical to the
 * per-session file route) because the project does not depend on `mime-types`
 * and a curated subset matches what dev-studio tools actually surface.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
}

const DEFAULT_MIME = 'application/octet-stream'

const ONE_MIB = 1024 * 1024
const TEN_MIB = 10 * ONE_MIB
const TWENTY_MIB = 20 * ONE_MIB

function sizeCapFor(mime: string): number {
  if (mime.startsWith('text/')) return ONE_MIB
  if (mime.startsWith('application/json')) return ONE_MIB
  if (mime.startsWith('application/xml')) return ONE_MIB
  if (mime.startsWith('application/yaml')) return ONE_MIB
  if (mime.startsWith('image/')) return TEN_MIB
  if (mime.startsWith('application/pdf')) return TWENTY_MIB
  return Number.POSITIVE_INFINITY
}

function mimeForPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase()
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME
}

/**
 * Join catch-all segments into a POSIX relative path, rejecting traversal.
 * Returns `null` when any segment is `..`, `.`, empty, absolute, or contains
 * a backslash.
 */
function joinSegmentsSafe(segments: readonly string[]): string | null {
  if (!segments.length) return null
  for (const seg of segments) {
    if (!seg || seg === '..' || seg === '.' || seg.startsWith('/') || seg.includes('\\')) {
      return null
    }
  }
  return segments.join('/')
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return new Response(auth.authenticated ? 'Forbidden' : 'Unauthorized', {
      status: auth.authenticated ? 403 : 401,
    })
  }

  const { id, path: segments } = await ctx.params

  const relPath = joinSegmentsSafe(segments ?? [])
  if (!relPath) {
    return new Response('Path traversal', { status: 400 })
  }

  const absPath = safeResolveInTool(id, relPath)
  if (!absPath) {
    return new Response('Path traversal', { status: 400 })
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(absPath)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!stat.isFile()) {
    return new Response('Not Found', { status: 404 })
  }

  const mime = mimeForPath(absPath)
  const cap = sizeCapFor(mime)
  if (stat.size > cap) {
    return new Response(JSON.stringify({ size: stat.size, mime, tooLarge: true }), {
      status: 412,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-file-size': String(stat.size),
      },
    })
  }

  const payload = await fs.readFile(absPath)
  return new Response(new Uint8Array(payload), {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(payload.byteLength),
    },
  })
}
