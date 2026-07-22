/**
 * Sessions collection endpoints.
 *
 * - POST: create the host workspace, persist a `tool_dev_sessions` row, then
 *   spawn the OpenSandbox container with two bind mounts (workspace + coder
 *   state). On failure the row is preserved with `containerStatus='destroyed'`
 *   so it still shows up in the user's session list.
 * - GET: list the current user's sessions filtered by status (sub-spec B §5).
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createLogger } from '@crewmeld/logger'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { resolveModelEnv } from '@/lib/dev-studio/model-resolver'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import type { ApiError } from '@/lib/dev-studio/schemas'
import { type SessionStatus, sessionStore } from '@/lib/dev-studio/session-store'

const log = createLogger('dev-studio:sessions')

const KNOWN_STATUSES = new Set<SessionStatus>(['active', 'adopted', 'archived'])

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
 * POST /api/employee/dev-studio/sessions
 *
 * Lifecycle:
 *  1. Authenticate; reject 401 if no session.
 *  2. Resolve coderType from env (claudecode or opencode) and select the provider.
 *  3. Allocate sessionId and materialise host directories for the provider's mounts.
 *  4. Persist a row in `tool_dev_sessions` with `containerStatus='creating'`.
 *     The row is preserved on any subsequent failure so the user still sees
 *     the session in their list and can rehydrate / archive it later.
 *  5. Spawn the OpenSandbox container via the provider's image/entrypoint/mounts.
 *     - claudecode: workspace + /root/.claude/projects
 *     - opencode: workspace + /root/.local/share/opencode
 *  6. Wait for Running, fetch the webui endpoint (provider.port), then patch the
 *     row with `activeContainerId` + `containerStatus='running'`.
 *
 * Errors:
 *  - mkdir failure → 500, no DB write.
 *  - createSandbox / waitUntilRunning / getEndpoint failure → row patched to
 *    `containerStatus='destroyed'`, 5xx returned. The container is best-effort
 *    destroyed; if `destroy` itself fails the OpenSandbox TTL is the backstop.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const userId = auth.userId

  // Optional model selection (Sub-spec C). A missing/empty body resolves to
  // null → global ANTHROPIC_* env fallback. Tolerate a non-JSON body so the
  // legacy no-body callers keep working.
  const body = (await req.json().catch(() => ({}))) as { modelConfigId?: string | null }
  const modelConfigId = body?.modelConfigId ?? null

  // Pre-flight: if the user already has a running container, suspend it
  // (destroy the container but keep the session active so it stays in the
  // list and can be rehydrated later). The DB partial unique index
  // `tool_dev_sessions_user_running_uidx` enforces at most 1 running
  // container per user — clearing the old one here avoids an orphan sandbox
  // if the index trips at the final UPDATE step.
  const existing = await sessionStore.list(userId, { status: 'active' })
  const running = existing.find((s) => s.containerStatus === 'running')
  if (running) {
    if (running.activeContainerId) {
      const suspendClient = new OpenSandboxClient({
        serverUrl: getDevStudioEnv().OPENSANDBOX_SERVER_URL,
        apiKey: getDevStudioEnv().OPENSANDBOX_API_KEY,
      })
      await suspendClient.destroy(running.activeContainerId).catch(() => {})
    }
    await sessionStore
      .update(running.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    log.info({ oldSessionId: running.id, userId }, 'suspended running session for new creation')
  }

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return errorResponse(503, 'config-missing', String(e), false)
  }

  // Resolve the model credentials for the container (Sub-spec C). Decrypts the
  // pinned model_configs row, or falls back to the global ANTHROPIC_* env.
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

  // 0. Pre-allocate the host paths using a fresh UUID, then persist the row.
  // The row's primary key is the same UUID, so the workspace path, coder
  // state path, bind-mount labels and the DB row all share one identifier.
  // Paths are derived from the cross-platform `paths` facade: forBff() gives
  // the local NFS-mount path (used for mkdir / DB debug column), forSandbox()
  // gives the Linux path the OpenSandbox host uses for bind mounts.
  const coderType = env.CREWMELD_CODER_DEFAULT
  const provider = getCoderProvider(coderType)

  const sessionId = randomUUID()
  const workspaceBffPath = paths.sessionWorkspace.forBff(sessionId)
  // claudeStateDir satisfies the NOT NULL constraint; for opencode we store
  // the opencode-data BFF path so the column has a meaningful value.
  const coderStateBffPath =
    coderType === 'opencode'
      ? paths.sessionOpencodeData.forBff(sessionId)
      : paths.sessionClaude.forBff(sessionId)

  // 1. Materialise host directories BEFORE spawning the container so bind
  // mounts land on existing paths (otherwise OpenSandbox may auto-create with
  // wrong perms or refuse). Directories depend on which coder is active.
  const bffDirs =
    coderType === 'opencode'
      ? [workspaceBffPath, paths.sessionOpencodeData.forBff(sessionId)]
      : [workspaceBffPath, paths.sessionClaude.forBff(sessionId)]
  try {
    for (const d of bffDirs) await mkdir(d, { recursive: true })
  } catch (e) {
    return errorResponse(
      500,
      'workspace-mkdir-failed',
      `Failed to create session directories for ${sessionId}: ${String(e)}`,
      false
    )
  }

  // 2. Persist the session row. We pass the pre-allocated `id` so the row,
  // its host paths and the bind-mount labels all share one identifier.
  // The `workspaceDir` / `claudeStateDir` DB columns store the BFF-side paths
  // for debug/observability only — runtime callers should re-derive via the
  // `paths` facade rather than reading these columns.
  const session = await sessionStore.create({
    id: sessionId,
    userId,
    coderType,
    workspaceDir: workspaceBffPath,
    claudeStateDir: coderStateBffPath,
    containerStatus: 'creating',
    modelConfigId,
    modelName: modelEnv.displayLabel,
  })

  // 3. Create sandbox using the provider's image/entrypoint/mounts. If the
  // call fails we mark the row destroyed and propagate a uniform error response.
  const modelEnvBlock = {
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
  }
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
        ...modelEnvBlock,
        ...(provider.id === 'opencode' && env.OPENCODE_SERVER_PASSWORD
          ? {
              OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
              OPENCODE_PORT: String(env.OPENCODE_PORT),
            }
          : {}),
      },
      volumes: provider.mounts(sessionId),
      metadata: { 'crewmeld.purpose': 'dev', 'crewmeld.session-id': sessionId },
    })
  } catch (e) {
    await sessionStore
      .update(session.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(502, 'sandbox-unreachable', String(e), true)
  }

  // 4. Wait for Running. On failure: best-effort destroy + row patch.
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

  // 5. Resolve webui endpoint. Same recovery pattern as above.
  let webuiUrl: string
  try {
    webuiUrl = await client.getEndpoint(sandbox.id, provider.port)
  } catch (e) {
    client.destroy(sandbox.id).catch(() => {})
    await sessionStore
      .update(session.id, { containerStatus: 'destroyed', activeContainerId: null })
      .catch(() => {})
    return errorResponse(502, 'sandbox-unreachable', String(e), true)
  }

  // 6. Promote the row to running. The pre-flight check above prevents most
  // duplicates, but there's still a narrow race window between the SELECT and
  // this UPDATE where a concurrent request can win. The DB partial unique
  // index `tool_dev_sessions_user_running_uidx` will fire in that case; we
  // catch the violation, tear the orphan container down and return 409.
  try {
    await sessionStore.update(session.id, {
      activeContainerId: sandbox.id,
      containerStatus: 'running',
    })
  } catch (e) {
    log.warn(
      { err: e, sessionId: session.id, userId },
      'failed to mark session as running, cleaning up orphan'
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

  return Response.json({ sessionId: session.id, endpoint: webuiUrl })
}

/**
 * GET /api/employee/dev-studio/sessions
 *
 * Lists Tool Dev Studio sessions owned by the authenticated user, ordered by
 * `lastActiveAt` desc. Supports the following filters:
 *
 * - `?status=active|adopted|archived|all` (default `active`; `all` skips status
 *   filter; unknown values fall back to `active`).
 * - `?toolId=<id>|none` (`none` matches sessions with NULL toolId; a string
 *   value matches sessions linked to that specific tool).
 * - `?q=substring` (case-insensitive substring match on `title`).
 *
 * Returns `{ sessions: SessionRecord[] }`. The handler does not perform any
 * cross-user lookups: ownership is enforced by passing `user.id` as the store's
 * `userId` filter.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const url = new URL(req.url)
  const q = url.searchParams.get('q') ?? undefined
  const rawStatus = url.searchParams.get('status')
  const toolId = url.searchParams.get('toolId') ?? undefined

  // 'all' passes through to skip the status filter; known statuses pass through;
  // unknown/missing values default to 'active'.
  const status: SessionStatus | 'all' =
    rawStatus === 'all'
      ? 'all'
      : rawStatus && KNOWN_STATUSES.has(rawStatus as SessionStatus)
        ? (rawStatus as SessionStatus)
        : 'active'

  const sessions = await sessionStore.list(auth.userId, { q, status, toolId })
  return Response.json({ sessions })
}
