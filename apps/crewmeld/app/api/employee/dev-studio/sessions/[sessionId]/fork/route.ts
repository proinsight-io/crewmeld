/**
 * POST /api/employee/dev-studio/sessions/:sessionId/fork
 *
 * Creates a new iteration session that reuses the workspace directory from the
 * most recent adopted session for the given tool. This enables tool iteration:
 * users open an adopted tool's dev-studio and click "new iteration" to get a
 * fresh session with the same workspace pre-loaded.
 *
 * Flow:
 *  1. Auth + parse body `{ toolId }`.
 *  2. Find the most recent adopted session for this toolId to source the
 *     workspace directory and claude state directory.
 *  3. Guard: reject 409 if another active session is already using this
 *     workspace (prevents concurrent writes to the same host directory).
 *  4. Spawn a sandbox container with the same workspace bind mount.
 *  5. Create a new `tool_dev_sessions` row linked to the tool, pointing at the
 *     same workspaceDir + claudeStateDir.
 *  6. Return `{ sessionId, containerId, containerStatus }`.
 */
import { randomUUID } from 'node:crypto'
import { access, cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { db, toolDevMessages } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { asc, eq } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import type { HostVolume } from '@/lib/dev-studio/opensandbox-client'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import type { ApiError } from '@/lib/dev-studio/schemas'
import { sessionStore } from '@/lib/dev-studio/session-store'

const log = createLogger('dev-studio:sessions:fork')

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

function errorResponse(
  status: number,
  error: string,
  detail: string,
  retryable: boolean
): Response {
  const body: ApiError = { error, detail, retryable }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Mirror of POST /sessions entrypoint builder. Kept local to avoid an import
 * cycle with the collection route.
 */
function buildEntrypoint(pipIndexUrl: string | undefined): string[] {
  const launch = 'exec claude-code-webui --host 0.0.0.0 --port 8080'
  if (!pipIndexUrl) return ['claude-code-webui', '--host', '0.0.0.0', '--port', '8080']
  const trustedHost = new URL(pipIndexUrl).host
  const setup = `mkdir -p /root/.pip && printf '[global]\\nindex-url=%s\\ntrusted-host=%s\\n' '${pipIndexUrl}' '${trustedHost}' > /root/.pip/pip.conf`
  return ['/bin/sh', '-c', `${setup} && ${launch}`]
}

/** DNS-label-safe volume name derived from sessionId. */
function volumeNameFor(prefix: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return `${prefix}-${safe.slice(0, 56)}`
}

/** Whether a host path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function POST(req: Request, _ctx: RouteContext): Promise<Response> {
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const userId = auth.userId

  // Parse body
  let body: { toolId?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'bad-request', 'Request body must be valid JSON', false)
  }

  const { toolId } = body
  if (!toolId || typeof toolId !== 'string') {
    return errorResponse(400, 'bad-request', 'toolId is required and must be a string', false)
  }

  // Find the most recent adopted session for this tool to source workspace dirs
  const adoptedSessions = await sessionStore.list(userId, { status: 'adopted', toolId })
  if (adoptedSessions.length === 0) {
    return errorResponse(
      404,
      'no-adopted-session',
      `No adopted session found for toolId '${toolId}'`,
      false
    )
  }

  // Sessions are ordered by lastActiveAt desc, so [0] is most recent
  const sourceSession = adoptedSessions[0]

  // Guard: no other active session should already be forking from this source.
  const activeSessions = await sessionStore.list(userId, { status: 'active', toolId })
  const conflicting = activeSessions.find((s) => s.workspaceDir === sourceSession.workspaceDir)
  if (conflicting) {
    return errorResponse(
      409,
      'workspace-in-use',
      `An active session (${conflicting.id}) is already using this workspace`,
      false
    )
  }

  // Inherit the source (adopted) session's pinned model so the iteration
  // continues on the same model the operator built the tool with. A null
  // modelConfigId resolves to the global env / auto-picked coding model via the
  // shared resolver — mirroring POST /sessions, instead of the old behavior of
  // hardcoding the global ANTHROPIC_* env (which broke when .env had no token
  // and never persisted modelConfigId, so the forked session showed no model).
  let modelEnv: Awaited<ReturnType<typeof resolveModelEnv>>
  try {
    modelEnv = await resolveModelEnv(sourceSession.modelConfigId)
  } catch (e) {
    return errorResponse(400, 'model-resolve-failed', String(e), false)
  }

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return errorResponse(503, 'config-missing', String(e), false)
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  // Pre-flight: suspend any running container owned by this user (same pattern
  // as POST /sessions) to avoid the partial unique index conflict.
  const existing = await sessionStore.list(userId, { status: 'active' })
  const running = existing.find((s) => s.containerStatus === 'running')
  if (running) {
    if (running.activeContainerId) {
      await client.destroy(running.activeContainerId).catch(() => {})
    }
    await sessionStore
      .update(running.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    log.info({ oldSessionId: running.id, userId }, 'suspended running session for fork')
  }

  // Materialise the new session's OWN workspace + claude dirs by copying the
  // source adopted session's. Every host path in the system is derived from the
  // session id via the `paths` facade; a fork that merely *mounted* the source
  // dirs left `sessions/<newId>/` nonexistent, so any id-derived consumer
  // (notably run-test's code-sync) failed with ENOENT scandir. Copying makes
  // the iteration self-contained and keeps it from mutating the adopted
  // baseline.
  const newSessionId = randomUUID()
  const srcWorkspace = paths.sessionWorkspace.forBff(sourceSession.id)
  const dstWorkspace = paths.sessionWorkspace.forBff(newSessionId)
  const srcClaude = paths.sessionClaude.forBff(sourceSession.id)
  const dstClaude = paths.sessionClaude.forBff(newSessionId)
  try {
    await mkdir(path.dirname(dstWorkspace), { recursive: true })
    await cp(srcWorkspace, dstWorkspace, { recursive: true })
    // Claude SDK resume state is best-effort: a missing source dir just means
    // the iteration starts without prior conversation context.
    if (await pathExists(srcClaude)) {
      await cp(srcClaude, dstClaude, { recursive: true })
    } else {
      await mkdir(dstClaude, { recursive: true })
    }
  } catch (e) {
    return errorResponse(
      500,
      'workspace-copy-failed',
      `Failed to copy source workspace for fork: ${String(e)}`,
      false
    )
  }

  // Create the new session row, pointing at its OWN (just-copied) dirs.
  const session = await sessionStore.create({
    id: newSessionId,
    userId,
    toolId,
    workspaceDir: dstWorkspace,
    claudeStateDir: dstClaude,
    containerStatus: 'creating',
    // Persist the EFFECTIVE id the resolver landed on, not the source input.
    // When the source was "系统默认" (null) and the global env model was later
    // removed, the resolver auto-picks a real coding config; persisting that
    // id (instead of the null input) is what lets the header selector display
    // the model actually in use rather than a blank.
    modelConfigId: modelEnv.modelConfigId,
    modelName: modelEnv.displayLabel,
  })

  // Carry the source session's chat history into the iteration so the operator
  // sees the conversation that built the tool instead of a blank panel. The
  // workspace + claude state copies above already preserve the model's resume
  // context; this copies the UI-facing `tool_dev_messages` timeline to match.
  // Rows are append-only and keyed by sessionId, so we re-key clones to the new
  // session, keeping `sequence` (so the chat route's max(sequence) continues
  // appending without collision) and dropping `id`/`createdAt` to let the
  // defaults assign fresh ones. Best-effort: a copy failure must not block the
  // fork — the iteration still works, just without visible prior history.
  try {
    const sourceMessages = await db
      .select()
      .from(toolDevMessages)
      .where(eq(toolDevMessages.sessionId, sourceSession.id))
      .orderBy(asc(toolDevMessages.sequence))
    if (sourceMessages.length > 0) {
      await db.insert(toolDevMessages).values(
        sourceMessages.map((m) => ({
          sessionId: newSessionId,
          sequence: m.sequence,
          kind: m.kind,
          payload: m.payload,
        }))
      )
    }
  } catch (e) {
    log.warn(
      { err: e, sourceSessionId: sourceSession.id, newSessionId },
      'failed to copy chat history into fork'
    )
  }

  // Spawn sandbox bound to the NEW session's dirs. hostPath is the sandbox-side
  // (Linux) view, derived from `newSessionId` — now populated by the copy above.
  const volumes: HostVolume[] = [
    {
      name: volumeNameFor('ws', newSessionId),
      hostPath: paths.sessionWorkspace.forSandbox(newSessionId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    {
      name: volumeNameFor('cl', newSessionId),
      hostPath: paths.sessionClaude.forSandbox(newSessionId),
      mountPath: '/root/.claude/projects',
      readOnly: false,
    },
  ]

  let sandbox: { id: string }
  try {
    sandbox = await client.createSandbox({
      image: env.CREWMELD_SANDBOX_IMAGE,
      entrypoint: buildEntrypoint(env.CREWMELD_PIP_INDEX_URL),
      resourceLimits: {
        cpu: env.CREWMELD_SANDBOX_CPU,
        memory: env.CREWMELD_SANDBOX_MEMORY,
      },
      timeoutSeconds: env.CREWMELD_SANDBOX_TTL_SECONDS,
      env: {
        ANTHROPIC_AUTH_TOKEN: modelEnv.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_BASE_URL: modelEnv.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: modelEnv.ANTHROPIC_MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: modelEnv.ANTHROPIC_SMALL_FAST_MODEL,
        ...(modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL
          ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL }
          : {}),
        ...(modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL
          ? { ANTHROPIC_DEFAULT_SONNET_MODEL: modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL }
          : {}),
        ...(modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL
          ? { ANTHROPIC_DEFAULT_OPUS_MODEL: modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL }
          : {}),
        API_TIMEOUT_MS: '600000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      volumes,
    })
  } catch (e) {
    await sessionStore
      .update(session.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(502, 'sandbox-unreachable', String(e), true)
  }

  // Wait for Running
  try {
    await client.waitUntilRunning(sandbox.id, { timeoutMs: 30_000, intervalMs: 1000 })
  } catch (e) {
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(session.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    const msg = String(e)
    if (msg.match(/timed out/i)) {
      return errorResponse(504, 'sandbox-timeout', msg, true)
    }
    return errorResponse(502, 'sandbox-unreachable', msg, true)
  }

  // Promote to running
  try {
    await sessionStore.update(session.id, {
      activeContainerId: sandbox.id,
      containerStatus: 'running',
    })
  } catch (e) {
    log.warn(
      { err: e, sessionId: session.id, userId },
      'failed to mark forked session as running, cleaning up orphan'
    )
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(session.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return new Response(
      JSON.stringify({
        error: 'race-condition',
        message: 'Another session was started simultaneously. Please try again.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  }

  return Response.json({
    sessionId: session.id,
    containerId: sandbox.id,
    containerStatus: 'running' as const,
  })
}
