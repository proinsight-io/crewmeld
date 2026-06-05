/**
 * POST /api/employee/dev-studio/sessions/:sessionId/rehydrate
 *
 * Brings the session back to a state where the UI can talk to a live
 * claude-code-webui. Two paths:
 *
 *  - **Probe**: if the row has an `activeContainerId` and OpenSandbox still
 *    resolves an endpoint for it, return `{ endpoint, alive: true }` — nothing
 *    was recreated, the box is still hot.
 *  - **Recreate**: otherwise spawn a fresh sandbox bound to the SAME host
 *    `workspaceDir` and `claudeStateDir` so user files + the SDK's per-
 *    conversation jsonl in `/root/.claude/projects` survive across container
 *    rotation, then patch the row and return `{ endpoint, alive: false }`.
 *    The mount is intentionally scoped to `projects/` so the image's own
 *    `/root/.claude/{plugins,settings.json,CLAUDE.md}` remain visible.
 *
 * Status guard: only `status='active'` sessions can be rehydrated; `adopted`
 * or `archived` return 410 Gone (they cannot host a live container).
 *
 * Errors mirror POST /sessions: a failure during recreate marks the row
 * `containerStatus='destroyed'` and returns the appropriate 5xx.
 */

import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import type { HostVolume } from '@/lib/dev-studio/opensandbox-client'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import type { ApiError } from '@/lib/dev-studio/schemas'
import { sessionStore } from '@/lib/dev-studio/session-store'

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
 * Mirror of {@link POST /sessions}'s entrypoint builder. Kept local to this
 * file to avoid an import cycle with the collection route; both paths spawn
 * containers and need identical pip-mirror handling.
 */
function buildEntrypoint(pipIndexUrl: string | undefined): string[] {
  const launch = 'exec claude-code-webui --host 0.0.0.0 --port 8080'
  if (!pipIndexUrl) return ['claude-code-webui', '--host', '0.0.0.0', '--port', '8080']
  const trustedHost = new URL(pipIndexUrl).host
  const setup = `mkdir -p /root/.pip && printf '[global]\\nindex-url=%s\\ntrusted-host=%s\\n' '${pipIndexUrl}' '${trustedHost}' > /root/.pip/pip.conf`
  return ['/bin/sh', '-c', `${setup} && ${launch}`]
}

/**
 * DNS-label-safe volume name derived from `sessionId`. Same scheme as POST
 * /sessions; rehydrated containers reuse the names to make orphan inspection
 * straightforward.
 */
function volumeNameFor(prefix: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return `${prefix}-${safe.slice(0, 56)}`
}

export async function POST(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }
  if (session.status !== 'active') {
    return errorResponse(
      410,
      'session-not-active',
      `Cannot rehydrate session in status '${session.status}'`,
      false
    )
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

  // 1. Probe path: maybe the container is still alive on OpenSandbox.
  if (session.activeContainerId) {
    try {
      const endpoint = await client.getEndpoint(session.activeContainerId, 8080)
      return Response.json({ endpoint, alive: true })
    } catch {
      // Fall through to recreate — endpoint not resolvable means the box is
      // gone or expired; we'll spin a fresh one bound to the same host dirs.
    }
  }

  // 1b. Enforce the single-running-per-user invariant before claiming
  // `running` for this session. A prior session whose container died but
  // whose row still reads `running` (TTL expiry / crewmeld restart) would
  // otherwise trip the partial unique index `tool_dev_sessions_user_running_uidx`
  // at the final UPDATE. Mirror POST /sessions: tear down the orphan container
  // and demote the stale row.
  const activeSessions = await sessionStore.list(auth.userId, { status: 'active' })
  const otherRunning = activeSessions.find(
    (s) => s.id !== sessionId && s.containerStatus === 'running'
  )
  if (otherRunning) {
    if (otherRunning.activeContainerId) {
      await client.destroy(otherRunning.activeContainerId).catch(() => {})
    }
    await sessionStore
      .update(otherRunning.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
  }

  // Resolve the session's pinned model (or global env fallback) so the
  // recreated container authenticates with the same credentials the session
  // was created with (Sub-spec C). modelConfigId may be null (fallback) or
  // have been nulled by ON DELETE SET NULL if the config was removed.
  let modelEnv: Awaited<ReturnType<typeof resolveModelEnv>>
  try {
    modelEnv = await resolveModelEnv(session.modelConfigId ?? null)
  } catch (e) {
    return errorResponse(400, 'model-resolve-failed', String(e), false)
  }

  // 2. Recreate path: spawn a sandbox bound to the existing host directories.
  // The claude mount is scoped to `/root/.claude/projects` so the image keeps
  // ownership of plugins + permission settings (see route docstring).
  //
  // hostPath must be the sandbox-side (Linux) view of the shared volume, not
  // the BFF-side path stored in `session.workspaceDir` / `session.claudeStateDir`.
  // On Windows BFF + Ubuntu sandbox deployments those DB columns hold a
  // Windows path string which OpenSandbox cannot mount. Re-derive via the
  // paths facade so both sides see the same NFS data.
  const volumes: HostVolume[] = [
    {
      name: volumeNameFor('ws', sessionId),
      hostPath: paths.sessionWorkspace.forSandbox(sessionId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    {
      name: volumeNameFor('cl', sessionId),
      hostPath: paths.sessionClaude.forSandbox(sessionId),
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
        API_TIMEOUT_MS: '600000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      volumes,
    })
  } catch (e) {
    await sessionStore
      .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(502, 'sandbox-unreachable', String(e), true)
  }

  try {
    await client.waitUntilRunning(sandbox.id, { timeoutMs: 30_000, intervalMs: 1000 })
  } catch (e) {
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    const msg = String(e)
    if (msg.match(/timed out/i)) {
      return errorResponse(504, 'sandbox-timeout', msg, true)
    }
    return errorResponse(502, 'sandbox-unreachable', msg, true)
  }

  let endpoint: string
  try {
    endpoint = await client.getEndpoint(sandbox.id, 8080)
  } catch (e) {
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(502, 'sandbox-unreachable', String(e), true)
  }

  try {
    await sessionStore.update(sessionId, {
      activeContainerId: sandbox.id,
      containerStatus: 'running',
    })
  } catch (e) {
    // Narrow race: a concurrent claim won the partial unique index between
    // the pre-flight demotion above and here. Tear down the orphan we just
    // spawned and surface 409 rather than a 500.
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(
      409,
      'race-condition',
      `Another session was started simultaneously: ${String(e)}`,
      true
    )
  }

  return Response.json({ endpoint, alive: false })
}
