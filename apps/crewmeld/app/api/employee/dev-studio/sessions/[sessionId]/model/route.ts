/**
 * PATCH /api/employee/dev-studio/sessions/:sessionId/model
 *
 * Switch the coding model for an active session mid-flight. Structurally this
 * is a "rehydrate with a new model": the running container is destroyed and a
 * fresh one is spawned bound to the SAME workspace/coder-state host directories,
 * so the AI conversation context and the user's files survive the swap. The
 * only difference from rehydrate is that we persist the new `modelConfigId`
 * first, so the recreated container picks up the newly-selected model's
 * credentials. The container image and mounts are derived from the EXISTING
 * session's `coderType` so claudecode and opencode sessions each get the
 * correct provider.
 *
 * Body: `{ modelConfigId: string | null }` — null switches back to the global
 * env default (Sub-spec C D2).
 *
 * @see docs/superpowers/specs/2026-05-26-tool-dev-studio-spec-C-design.md §4.5
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import { buildOpenCodeConfig } from '@/lib/dev-studio/opencode-config'
import {
  abortOpencodeSession,
  CREWMELD_OPENCODE_PROVIDER_ID,
  findLastVisibleUserText,
  listOpencodeMessages,
  promptOpencodeAsync,
} from '@/lib/dev-studio/opencode-rest'
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

  // Resolve the provider from the EXISTING session's coderType so the recreated
  // container uses the same image, entrypoint, and mounts as the original.
  const provider = getCoderProvider(session.coderType ?? 'claudecode')

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  let replayText: string | null = null
  let aborted = false

  // OpenCode persists its session independently of the container. Snapshot the
  // operator's last question and explicitly abort the active turn before
  // destroying the container, otherwise it can keep the old model reference.
  if (provider.id === 'opencode' && session.activeContainerId && session.opencodeSessionId) {
    try {
      const oldEndpoint = await client.getEndpoint(session.activeContainerId, provider.port)
      const headers = {
        ...(provider.authHeader(env) ?? {}),
        ...client.proxyHeaders(),
      }
      const history = await listOpencodeMessages(oldEndpoint, headers, session.opencodeSessionId)
      replayText = findLastVisibleUserText(history)
      await abortOpencodeSession(oldEndpoint, headers, session.opencodeSessionId)
      aborted = true
    } catch (e) {
      return errorResponse(502, 'abort-failed', String(e), true)
    }
  }

  // 1. Tear down the current container (best-effort) and pin the row to the new
  // model in a single 'creating' update. The old container must die so the
  // single-running-per-user partial unique index stays satisfiable.
  if (session.activeContainerId) {
    await client.destroy(session.activeContainerId).catch(() => {})
  }
  await sessionStore.update(sessionId, {
    modelConfigId: modelEnv.modelConfigId ?? modelConfigId,
    modelName: modelEnv.displayLabel,
    containerStatus: 'creating',
    activeContainerId: null,
  })

  // 2. Spawn a fresh container on the SAME host directories (forSandbox() Linux
  // paths) so files + SDK conversation state survive the model swap. Volumes are
  // derived from the provider so the correct coder-state path is mounted.
  let sandbox: { id: string }
  try {
    sandbox = await client.createSandbox({
      image: provider.image(env),
      entrypoint: provider.buildEntrypoint({ env, pipIndexUrl: env.CREWMELD_PIP_INDEX_URL }),
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
        ...(provider.id === 'opencode' && env.OPENCODE_SERVER_PASSWORD
          ? {
              OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
              OPENCODE_PORT: String(env.OPENCODE_PORT),
            }
          : {}),
        ...(provider.id === 'opencode'
          ? {
              OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig({
                providerID: CREWMELD_OPENCODE_PROVIDER_ID,
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

  await sessionStore.update(sessionId, {
    activeContainerId: sandbox.id,
    containerStatus: 'running',
  })

  let replay: 'started' | 'skipped' | 'failed' = replayText ? 'started' : 'skipped'
  let replayError: string | undefined
  if (replayText && provider.id === 'opencode' && session.opencodeSessionId) {
    try {
      await promptOpencodeAsync(
        endpoint,
        {
          ...(provider.authHeader(env) ?? {}),
          ...client.proxyHeaders(),
        },
        session.opencodeSessionId,
        `[系统提示] 编程模型已切换。请重新回答用户上一条问题：\n${replayText}`,
        {
          providerID: CREWMELD_OPENCODE_PROVIDER_ID,
          modelID: modelEnv.ANTHROPIC_MODEL,
        }
      )
    } catch (e) {
      replay = 'failed'
      replayError = String(e)
    }
  }

  return Response.json({
    endpoint,
    modelName: modelEnv.displayLabel,
    modelConfigId: modelEnv.modelConfigId ?? modelConfigId,
    aborted,
    replay,
    ...(replayError ? { replayError } : {}),
  })
}
