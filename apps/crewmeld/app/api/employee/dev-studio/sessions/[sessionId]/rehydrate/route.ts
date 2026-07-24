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
 *    workspace and coder-state directories so user files + per-conversation
 *    state survive across container rotation, then patch the row and return
 *    `{ endpoint, alive: false }`. The coder-state mount target depends on the
 *    session's `coderType` (claudecode: `/root/.claude/projects`; opencode:
 *    `/root/.local/share/opencode`).
 *
 * Status guard: only `status='active'` sessions can be rehydrated; `adopted`
 * or `archived` return 410 Gone (they cannot host a live container).
 *
 * Errors mirror POST /sessions: a failure during recreate marks the row
 * `containerStatus='destroyed'` and returns the appropriate 5xx.
 */

import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import { buildOpenCodeConfig } from '@/lib/dev-studio/opencode-config'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
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

  // Resolve the provider from the EXISTING session's coderType so we use the
  // correct image, entrypoint, mounts, and endpoint port for this session.
  const provider = getCoderProvider(session.coderType ?? 'claudecode')

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  // 1. Probe path: maybe the container is still alive on OpenSandbox.
  //
  // We MUST verify liveness against the lifecycle API via isSandboxRunning, NOT
  // getEndpoint: in proxy mode getEndpoint only string-builds the reverse-proxy
  // URL without touching the server, so it "succeeds" even for a container that
  // was reaped/expired — which would wrongly report `alive: true` and skip the
  // recreate path forever. Any non-Running / not-found / unreachable result
  // falls through to recreate a fresh box bound to the same host dirs.
  if (session.activeContainerId) {
    const alive = await client.isSandboxRunning(session.activeContainerId).catch(() => false)
    if (alive) {
      const endpoint = await client.getEndpoint(session.activeContainerId, provider.port)
      return Response.json({ endpoint, alive: true })
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
  // Volumes are derived from the provider so the correct coder-state path is
  // mounted (claudecode: /root/.claude/projects; opencode:
  // /root/.local/share/opencode). hostPath must be the sandbox-side (Linux)
  // view of the shared volume, re-derived via the paths facade rather than
  // read from the DB columns which may hold a Windows path on Windows BFF.
  let sandbox: { id: string }
  try {
    sandbox = await client.createSandbox({
      image: provider.image(env),
      entrypoint: provider.buildEntrypoint({ env, pipIndexUrl: env.CREWMELD_PIP_INDEX_URL }),
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
        ...(provider.id === 'opencode' && env.OPENCODE_SERVER_PASSWORD
          ? {
              OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
              OPENCODE_PORT: String(env.OPENCODE_PORT),
            }
          : {}),
        ...(provider.id === 'opencode'
          ? {
              OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig({
                providerID: 'myprovider',
                modelID: modelEnv.opencodeModelID,
                baseURL: modelEnv.opencodeBaseURL,
                apiKey: modelEnv.opencodeApiKey,
              }),
            }
          : {}),
      },
      volumes: provider.mounts(sessionId),
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
    endpoint = await client.getEndpoint(sandbox.id, provider.port)
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
