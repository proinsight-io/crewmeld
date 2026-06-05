/**
 * GET + PUT /api/employee/dev-studio/sessions/:sessionId/readme
 *
 * Reads/writes `.crewmeld-studio/README.md` inside the sandbox container
 * via OpenSandbox execd files API when a container is active; falls back to
 * host filesystem otherwise. Same dual-path strategy as the manifest route.
 *
 * Errors:
 *  - 400 — body is not JSON or `markdown` is missing/not a string
 *  - 401 — unauthenticated
 *  - 404 — session missing, owned by another user, or (GET) no README yet
 *  - 413 — markdown exceeds README_MAX_BYTES (100 KiB)
 *
 * Cross-user lookups return 404 (not 403) to match sibling routes.
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import {
  README_MAX_BYTES,
  README_RELATIVE_PATH,
  readReadmeFromSession,
  writeReadmeFromSession,
} from '@/lib/dev-studio/readme-store'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const CONTAINER_README_PATH = `/root/workspace/${README_RELATIVE_PATH}`

/** PUT body schema. `markdown` is required, no other fields allowed. */
const PutSchema = z.object({ markdown: z.string() }).strict()

function getClient(): OpenSandboxClient {
  const env = getDevStudioEnv()
  return new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })
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

  // Prefer reading from live container; fall back to host filesystem
  if (session.activeContainerId) {
    try {
      const client = getClient()
      const files = await client.getFiles(session.activeContainerId)
      const md = await files.readFile(CONTAINER_README_PATH)
      return new Response(md, {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      })
    } catch {
      // Container unreachable — fall through to host-fs fallback
    }
  }

  const md = await readReadmeFromSession(sessionId)
  if (md === null) {
    return new Response('Not Found', { status: 404 })
  }
  return new Response(md, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  })
}

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = PutSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const markdown = parsed.data.markdown
  const byteLength = Buffer.byteLength(markdown, 'utf-8')
  if (byteLength > README_MAX_BYTES) {
    return new Response(`README exceeds ${README_MAX_BYTES} bytes (got ${byteLength})`, { status: 413 })
  }

  // Prefer writing to live container; fall back to host filesystem
  if (session.activeContainerId) {
    try {
      const client = getClient()
      const filesApi = await client.getFiles(session.activeContainerId)
      await filesApi.writeFiles([{ path: CONTAINER_README_PATH, data: markdown }])
      return new Response(null, { status: 204 })
    } catch {
      // Container unreachable — fall through to host-fs fallback
    }
  }

  try {
    await writeReadmeFromSession(sessionId, markdown)
    return new Response(null, { status: 204 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('exceeds')) {
      return new Response(message, { status: 413 })
    }
    throw err
  }
}
