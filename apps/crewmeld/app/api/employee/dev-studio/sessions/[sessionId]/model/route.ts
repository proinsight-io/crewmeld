/**
 * PATCH /api/employee/dev-studio/sessions/:sessionId/model
 *
 * Switch the coding model for an active session mid-flight. Structurally this
 * is a "rehydrate with a new model": the running container is destroyed and a
 * fresh one is spawned bound to the SAME workspace/claude host directories, so
 * the AI conversation context (persisted under /root/.claude/projects) and the
 * user's files survive the swap. The only difference from rehydrate is that we
 * persist the new `modelConfigId` first, so the recreated container picks up
 * the newly-selected model's credentials.
 *
 * Body: `{ modelConfigId: string | null }` — null switches back to the global
 * env default (Sub-spec C D2).
 *
 * @see docs/superpowers/specs/2026-05-26-tool-dev-studio-spec-C-design.md §4.5
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import { type HostVolume, OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
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
 * Mirror of POST /sessions's entrypoint builder. Kept local to avoid an import
 * cycle with the collection route (same rationale as rehydrate/route.ts).
 */
function buildEntrypoint(pipIndexUrl: string | undefined): string[] {
  const launch = 'exec claude-code-webui --host 0.0.0.0 --port 8080'
  if (!pipIndexUrl) return ['claude-code-webui', '--host', '0.0.0.0', '--port', '8080']
  const trustedHost = new URL(pipIndexUrl).host
  const setup = `mkdir -p /root/.pip && printf '[global]\\nindex-url=%s\\ntrusted-host=%s\\n' '${pipIndexUrl}' '${trustedHost}' > /root/.pip/pip.conf`
  return ['/bin/sh', '-c', `${setup} && ${launch}`]
}

function volumeNameFor(prefix: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return `${prefix}-${safe.slice(0, 56)}`
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
  if (session.status !== 'active') {
    return errorResponse(
      410,
      'session-not-active',
      `Cannot switch model on session in status '${session.status}'`,
      false
    )
  }

  // Parse + normalise the requested model. A missing/empty body or explicit
  // null both mean "system default" (global env fallback).
  const body = (await req.json().catch(() => ({}))) as { modelConfigId?: string | null }
  const modelConfigId = body?.modelConfigId ?? null

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return errorResponse(503, 'config-missing', String(e), false)
  }

  let modelEnv: Awaited<ReturnType<typeof resolveModelEnv>>
  try {
    modelEnv = await resolveModelEnv(modelConfigId)
  } catch (e) {
    return errorResponse(400, 'model-resolve-failed', String(e), false)
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  // 1. Tear down the current container (best-effort) and pin the row to the new
  // model in a single 'creating' update. The old container must die so the
  // single-running-per-user partial unique index stays satisfiable.
  if (session.activeContainerId) {
    await client.destroy(session.activeContainerId).catch(() => {})
  }
  await sessionStore.update(sessionId, {
    modelConfigId,
    modelName: modelEnv.displayLabel,
    containerStatus: 'creating',
    activeContainerId: null,
  })

  // 2. Spawn a fresh container on the SAME host directories (forSandbox() Linux
  // paths) so files + SDK conversation state survive the model swap.
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
      resourceLimits: { cpu: env.CREWMELD_SANDBOX_CPU, memory: env.CREWMELD_SANDBOX_MEMORY },
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

  await sessionStore.update(sessionId, {
    activeContainerId: sandbox.id,
    containerStatus: 'running',
  })

  return Response.json({ endpoint, modelName: modelEnv.displayLabel })
}
