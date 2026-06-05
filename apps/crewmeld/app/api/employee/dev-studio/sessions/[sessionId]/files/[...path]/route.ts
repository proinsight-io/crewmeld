/**
 * GET /api/employee/dev-studio/sessions/:sessionId/files/[...path]
 *
 * Streams a single file from the per-session workspace inside the sandbox.
 * Reads through the OpenSandbox SDK execd `files` surface — same path the
 * file-tree route uses — so the route works in both in-cluster (direct
 * pod IP) and dev-workstation (server reverse-proxy) deployment modes.
 *
 * Path safety: the catch-all `[...path]` is joined with `/` and rejected if
 * any segment is `..` or absolute. Absolute paths slip through Windows-host
 * `path.resolve` checks, so we filter at the segment level instead.
 *
 * Size policy (per mime kind, applied to the SDK-reported `size`):
 *  - text/* + application/json|xml|yaml : 1 MiB
 *  - image/*                            : 10 MiB
 *  - application/pdf                    : 20 MiB
 *  - everything else                    : unbounded
 *
 * When the file exceeds its cap, returns 412 with `{ size, mime, tooLarge }`
 * plus `X-File-Size` so the UI can render a "too large to preview"
 * affordance without downloading.
 */
import path from 'node:path'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import type { FlatFileEntry } from '@/lib/dev-studio/file-tree'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string; path: string[] }>
}

/** Sandbox-side workspace root. */
const WORKSPACE_ROOT = '/root/workspace'

/**
 * Tiny extension → mime mapping. Kept inline because the project does not
 * depend on `mime-types` and a curated subset matches what dev-studio
 * actually surfaces (text, json/yaml/xml, common images, pdf).
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
 * Join the catch-all path segments into a POSIX relative path, rejecting
 * traversal attempts. Returns `null` when any segment is `..`, empty, or
 * looks absolute.
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

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId, path: segments } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }
  if (!session.activeContainerId) {
    return new Response('Not Found', { status: 404 })
  }

  const relPath = joinSegmentsSafe(segments ?? [])
  if (!relPath) {
    return new Response('Path traversal', { status: 400 })
  }
  const absPath = `${WORKSPACE_ROOT}/${relPath}`

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'config-missing', detail: String(e), retryable: false }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  const files = await client.getFiles(session.activeContainerId)

  // Look up the target's metadata via search on its parent dir. The SDK's
  // `getFileInfo` returned `{}` in probes — search is the reliable path to
  // a size + existence check. Search is already used by the tree route, so
  // the second call here usually hits a warm execd connection.
  const lastSlash = absPath.lastIndexOf('/')
  const parentAbs = lastSlash > 0 ? absPath.slice(0, lastSlash) : WORKSPACE_ROOT
  let target: FlatFileEntry | undefined
  try {
    const siblings = (await files.search({ path: parentAbs })) as FlatFileEntry[]
    target = siblings.find((e) => e.path === absPath)
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'sandbox-files-unreachable',
        detail: String(e),
        retryable: true,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }
  if (!target) {
    return new Response('Not Found', { status: 404 })
  }

  const mime = mimeForPath(absPath)
  const cap = sizeCapFor(mime)
  const size = target.size ?? 0
  if (size > cap) {
    return new Response(JSON.stringify({ size, mime, tooLarge: true }), {
      status: 412,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-file-size': String(size),
      },
    })
  }

  // Read raw bytes via SDK readBytes. Important: SDK signature is
  // `readBytes(path: string, opts?)` — passing `{ path }` here causes the
  // SDK to encodeURIComponent the object's stringification ("[object
  // Object]") and the server responds 404 "Download failed". `readFile`
  // wraps readBytes with a utf-8 decode, which would corrupt binary
  // payloads (images, PDFs), so we stay on readBytes for both text and
  // binary and let the response Content-Type drive the browser.
  let payload: Uint8Array
  try {
    payload = await files.readBytes(absPath)
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'sandbox-files-unreachable',
        detail: String(e),
        retryable: true,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  return new Response(payload, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(payload.byteLength),
    },
  })
}
