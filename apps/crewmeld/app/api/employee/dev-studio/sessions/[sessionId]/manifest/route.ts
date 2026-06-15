/**
 * GET + PATCH /api/employee/dev-studio/sessions/:sessionId/manifest
 *
 * Reads/writes `.crewmeld-studio/manifest.json` inside the sandbox container
 * via OpenSandbox execd files API — NOT the BFF host filesystem. This ensures
 * the route works in local dev mode where the host cannot reach the sandbox's
 * bind-mounted directories.
 *
 * GET returns the AI-authored manifest; PATCH merges a narrow whitelist
 * (`name`, `description`) over the existing file.
 *
 * Auth + ownership: cross-user lookups return 404 (not 403) — matches sibling
 * routes to avoid leaking session existence.
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import {
  MANIFEST_RELATIVE_PATH,
  Manifest,
  overrideTimestampsInPlace,
  patchManifestFromSession,
  readManifestFromSession,
} from '@/lib/dev-studio/manifest-reader'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import { sessionStore } from '@/lib/dev-studio/session-store'
import path from 'node:path'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const CONTAINER_MANIFEST_PATH = `/root/workspace/${MANIFEST_RELATIVE_PATH}`

/**
 * PATCH body schema — intentionally narrow.
 *
 * The UI is only allowed to mutate human-readable metadata. Structural
 * fields (entrypoint, kind, dependencies, IO contract) are AI-authored and
 * must round-trip through the agent so they stay consistent with the rest
 * of the workspace.
 */
const PatchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    description: z.string().max(500).optional(),
  })
  .strict()

function getClient(): OpenSandboxClient {
  const env = getDevStudioEnv()
  return new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })
}

/**
 * 422 response for a manifest that exists but is not valid JSON / fails schema
 * validation (e.g. the AI wrote unescaped double-quotes inside a string value).
 * Carries the `sessionId` so operators can locate the broken file directly
 * instead of staring at an opaque 500.
 */
function manifestInvalidResponse(sessionId: string, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err)
  return new Response(
    JSON.stringify({ error: 'manifest-invalid', sessionId, detail, retryable: false }),
    { status: 422, headers: { 'content-type': 'application/json' } }
  )
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

  // Prefer reading from live container; fall back to host filesystem.
  if (session.activeContainerId) {
    let raw: string | undefined
    try {
      const client = getClient()
      const files = await client.getFiles(session.activeContainerId)
      raw = await files.readFile(CONTAINER_MANIFEST_PATH)
    } catch {
      // Container unreachable / file absent — fall through to host-fs fallback.
    }
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as unknown
        // Override AI-fabricated createdAt/updatedAt with the host fs mtime
        // — the workspace is bind-mounted via NFS so the BFF host can stat
        // the same file the sandbox writes. When host fs is unreachable
        // (local dev) the helper falls back to "now", which still beats
        // the AI's invented "4 hours ago" on a brand-new session.
        const fp = path.join(paths.sessionWorkspace.forBff(sessionId), MANIFEST_RELATIVE_PATH)
        await overrideTimestampsInPlace(parsed, fp)
        const manifest = Manifest.parse(parsed)
        return Response.json({ manifest })
      } catch (err) {
        // The container HAS a manifest but it's malformed (e.g. unescaped
        // quotes in a string value). Surface it as 422 with the sessionId
        // rather than masking it behind the host fallback or crashing 500.
        console.error(`[manifest GET] malformed manifest for session ${sessionId}:`, err)
        return manifestInvalidResponse(sessionId, err)
      }
    }
  }

  try {
    const manifest = await readManifestFromSession(sessionId)
    if (!manifest) {
      return new Response('Not Found', { status: 404 })
    }
    return Response.json({ manifest })
  } catch (err) {
    console.error(`[manifest GET] malformed manifest (host) for session ${sessionId}:`, err)
    return manifestInvalidResponse(sessionId, err)
  }
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
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
  const parsed = PatchSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  // Prefer writing to live container; fall back to host filesystem
  if (session.activeContainerId) {
    try {
      const client = getClient()
      const filesApi = await client.getFiles(session.activeContainerId)
      const currentRaw = await filesApi.readFile(CONTAINER_MANIFEST_PATH)
      const current = Manifest.parse(JSON.parse(currentRaw) as unknown)
      const next = { ...current, ...parsed.data, updatedAt: new Date().toISOString() }
      const validated = Manifest.parse(next)
      await filesApi.writeFiles([
        {
          path: CONTAINER_MANIFEST_PATH,
          data: JSON.stringify(validated, null, 2),
        },
      ])
      return Response.json({ manifest: validated })
    } catch {
      // Container unreachable — fall through to host-fs fallback
    }
  }

  try {
    const next = await patchManifestFromSession(sessionId, parsed.data)
    return Response.json({ manifest: next })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('CONFLICT')) {
      return new Response('Manifest does not exist', { status: 409 })
    }
    // A malformed existing manifest (invalid JSON / schema) can't be patched —
    // surface 422 with the sessionId instead of a 500.
    console.error(`[manifest PATCH] cannot patch manifest for session ${sessionId}:`, err)
    return manifestInvalidResponse(sessionId, err)
  }
}
