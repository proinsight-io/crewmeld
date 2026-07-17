import { db, toolDevMessages } from '@crewmeld/db'
import { asc, eq } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { discoverOpencodeSessionId, readOpencodeHistoryFromDisk } from '@/lib/dev-studio/opencode-db'
import type { OpencodeMessageWithParts } from '@/lib/dev-studio/opencode-rest'
import { listOpencodeMessages } from '@/lib/dev-studio/opencode-rest'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Narrow an unknown opencode message info object to extract id and role.
 * Returns null when the required fields are missing or invalid.
 */
interface OpencodeMessageInfo {
  id: string
  role: 'user' | 'assistant'
}

function parseMessageInfo(info: unknown): OpencodeMessageInfo | null {
  if (!info || typeof info !== 'object') return null
  const o = info as Record<string, unknown>
  if (typeof o['id'] !== 'string') return null
  if (o['role'] !== 'user' && o['role'] !== 'assistant') return null
  return { id: o['id'], role: o['role'] }
}

/**
 * Narrow an unknown opencode part to the shape the hook expects.
 * Parts from opencode carry at minimum {id, type}; extra fields pass through.
 */
interface OpencodePart {
  id: string
  type: string
  [k: string]: unknown
}

/** Message shape returned by GET /messages for opencode sessions. */
interface OpencodeUiMessage {
  id: string
  role: 'user' | 'assistant'
  parts: OpencodePart[]
}

function parsePart(part: unknown): OpencodePart | null {
  if (!part || typeof part !== 'object') return null
  const o = part as Record<string, unknown>
  if (typeof o['id'] !== 'string') return null
  if (typeof o['type'] !== 'string') return null
  return o as OpencodePart
}

/**
 * Map raw opencode message rows (from REST or disk) to the UI shape expected
 * by the `useOpencodeStream` hook. Extracted as a helper so both the disk and
 * REST branches share exactly the same mapping logic (DRY).
 */
function toUiMessages(raw: OpencodeMessageWithParts[]): OpencodeUiMessage[] {
  const mapped: OpencodeUiMessage[] = []
  for (const item of raw) {
    const info = parseMessageInfo(item.info)
    if (!info) continue
    const parts = Array.isArray(item.parts)
      ? item.parts.map(parsePart).filter((p): p is OpencodePart => p !== null)
      : []
    mapped.push({ id: info.id, role: info.role, parts })
  }
  return mapped
}

/**
 * GET /api/employee/dev-studio/sessions/:sessionId/messages
 *
 * Returns the persisted message timeline for a session, ordered by sequence.
 * Used by the frontend to restore chat history when switching between sessions.
 *
 * For opencode sessions, history lives in the opencode.db inside the sandbox
 * (never in tool_dev_messages). This branch reads it via REST and maps to the
 * {@link OpencodeUiMessage} shape the useOpencodeStream hook expects.
 * Response shape: `{ messages: Array<{ id: string, role: 'user'|'assistant', parts: OpencodePart[] }> }`.
 * This matches what useOpencodeStream parses as `data.messages`.
 *
 * For claudecode sessions the existing tool_dev_messages read path is unchanged.
 */
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

  // ── opencode branch ─────────────────────────────────────────────────────────
  // History is stored in opencode.db (inside the sandbox when running, or
  // mounted on disk when no container is active). Map rows to OpencodeUiMessage[].
  if (session.coderType === 'opencode') {
    const dbPath = `${paths.sessionOpencodeData.forBff(sessionId)}/opencode.db`

    // No live container → read history straight off the mounted opencode.db so
    // a resumed/adopted session shows its prior conversation without a running
    // sandbox. The row's opencodeSessionId is authoritative; when absent (e.g. a
    // fork made before the id was persisted) fall back to discovering the root
    // session from the db itself.
    if (!session.activeContainerId) {
      const sid = session.opencodeSessionId ?? discoverOpencodeSessionId(dbPath)
      const raw = sid ? readOpencodeHistoryFromDisk(dbPath, sid) : []
      return Response.json({ messages: toUiMessages(raw), opencodeSessionId: sid })
    }

    // Live container → read the authoritative timeline over REST (unchanged).
    if (!session.opencodeSessionId) {
      return Response.json({ messages: [], opencodeSessionId: null })
    }

    const env = getDevStudioEnv()
    const provider = getCoderProvider('opencode')
    const client = new OpenSandboxClient({
      serverUrl: env.OPENSANDBOX_SERVER_URL,
      apiKey: env.OPENSANDBOX_API_KEY,
      useProxy: env.OPENSANDBOX_USE_PROXY,
    })

    let baseUrl: string
    try {
      baseUrl = await client.getEndpoint(session.activeContainerId, provider.port)
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'sandbox-unreachable', detail: String(e), retryable: true }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      )
    }

    const headers: Record<string, string> = {
      ...(provider.authHeader(env) ?? {}),
      ...client.proxyHeaders(),
    }

    try {
      const raw = await listOpencodeMessages(baseUrl, headers, session.opencodeSessionId)
      return Response.json({
        messages: toUiMessages(raw),
        opencodeSessionId: session.opencodeSessionId,
      })
    } catch (e) {
      // A 404 means the sandbox is gone (reaped/expired) — the proxy could not
      // find it. Confirm against the lifecycle API; if it is truly not running,
      // demote the row (so the UI can offer rehydrate via the 60s poll) and
      // serve the last-known history straight off the mounted opencode.db so the
      // conversation still renders without a live container. Any other error, or
      // a still-running container, rethrows unchanged.
      const is404 = e instanceof Error && / failed: 404$/.test(e.message)
      if (is404 && session.activeContainerId) {
        const running = await client.isSandboxRunning(session.activeContainerId).catch(() => true)
        if (!running) {
          await sessionStore
            .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
            .catch(() => {})
          const sid = session.opencodeSessionId ?? discoverOpencodeSessionId(dbPath)
          const rawDisk = sid ? readOpencodeHistoryFromDisk(dbPath, sid) : []
          return Response.json({ messages: toUiMessages(rawDisk), opencodeSessionId: sid })
        }
      }
      throw e
    }
  }
  // ── end opencode branch ──────────────────────────────────────────────────────

  const rows = await db
    .select()
    .from(toolDevMessages)
    .where(eq(toolDevMessages.sessionId, sessionId))
    .orderBy(asc(toolDevMessages.sequence))

  return Response.json({ messages: rows })
}
