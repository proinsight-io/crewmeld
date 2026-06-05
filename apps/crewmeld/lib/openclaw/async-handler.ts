/**
 * OpenClaw async dispatch handler — OpenAI-compatible REST integration.
 *
 * Fire-and-forget background worker invoked from the conversation engine when
 * the LLM produces an `ask_openclaw` tool call. Posts the user message to
 * OpenClaw's official server-to-server endpoint
 * (`POST /v1/chat/completions`, OpenAI-compatible) and writes the response
 * back as a fresh assistant message — both persisted into
 * `conversation_messages` and pushed to the IM channel bound to the
 * conversation.
 *
 * Pool semantics:
 *   - `system_connections.config.endpoints` is `[{label, url, token}, ...]`,
 *     at least one entry.
 *   - On each invocation the handler shuffles the pool (Fisher–Yates) and
 *     tries entries in order until one succeeds or all are exhausted.
 *   - **Retryable failures** — timeouts, network errors, HTTP 5xx — cause the
 *     handler to move on to the next endpoint.
 *   - **Deterministic failures** — HTTP 4xx — short-circuit the loop: another
 *     endpoint with the same credentials would also fail.
 *   - When every endpoint fails (including the single-endpoint case), one
 *     aggregated `[OpenClaw all gateways failed]` message is emitted listing
 *     each endpoint's reason.
 *
 * Contract:
 *   - `dispatchOpenclawAsync` MUST NOT throw to the caller. Every failure mode
 *     (config error, all-endpoints failed, uncaught) is captured and surfaced
 *     as an assistant message.
 *   - Hard timeout per endpoint: 15 minutes (`AbortSignal.timeout`).
 *   - Credentials are read via `resolveCredentialById` so encryption is
 *     handled transparently.
 *
 * OpenClaw side requirements (admin-facing):
 *   - `gateway.http.endpoints.chatCompletions.enabled: true` in openclaw.json
 *   - `gateway.auth.token` matches the endpoint token we send
 *   - Process restart required after config edits
 */

import { channelSessions, conversationMessages, db } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { getPlugin } from '@/lib/channels/plugin-registry'
import '@/lib/channels/plugins'
import { resolveCredentialById } from '@/lib/connectors/resolver'
import type { OpenclawEndpoint } from '@/lib/connectors/types'
import { formatOpenclawResult } from './result-formatter'

const logger = createLogger('OpenclawAsync')

/** Hard wall-clock timeout for a single OpenClaw REST invocation (15 minutes). */
const HARD_TIMEOUT_MS = 15 * 60 * 1000

/** Default OpenAI-style model alias. Maps to OpenClaw's configured default agent. */
const DEFAULT_MODEL = 'openclaw'

export interface DispatchOpenclawArgs {
  /** Caller-provided correlation id used in metadata + logs. */
  taskId: string
  /** Internal conversation id (FK to `conversations.id`). */
  conversationId: string
  /** `system_connections.id` of type `openclaw`. */
  connectionId: string
  /** The user-facing question to forward to OpenClaw. */
  args: { message: string; model?: string }
}

/** Outcome of a single-endpoint attempt. */
type EndpointAttempt =
  | { ok: true; content: string }
  | { ok: false; reason: string; retryable: boolean }

/**
 * Fire-and-forget entry point. Always resolves; never rejects.
 */
export async function dispatchOpenclawAsync(params: DispatchOpenclawArgs): Promise<void> {
  try {
    await runDispatch(params)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('dispatchOpenclawAsync uncaught', {
      taskId: params.taskId,
      conversationId: params.conversationId,
      error: errMsg,
    })
    await persistAndSend({
      conversationId: params.conversationId,
      taskId: params.taskId,
      content: `[OpenClaw internal error] ${errMsg}`,
    }).catch((sendErr) => {
      logger.error('persistAndSend last-resort failed', {
        taskId: params.taskId,
        conversationId: params.conversationId,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      })
    })
  }
}

/** Core dispatch flow. May throw — wrapped by `dispatchOpenclawAsync`. */
async function runDispatch(params: DispatchOpenclawArgs): Promise<void> {
  const { taskId, conversationId, connectionId, args } = params

  const credential = await resolveCredentialById(connectionId)
  if (!credential || credential.type !== 'openclaw') {
    await persistAndSend({
      conversationId,
      taskId,
      content: '[OpenClaw config error] Connection not found or type mismatch',
    })
    return
  }

  const config = credential.config as Record<string, unknown>
  const rawEndpoints = Array.isArray(config.endpoints) ? (config.endpoints as unknown[]) : []
  const endpoints = rawEndpoints.filter(isValidEndpoint)
  if (endpoints.length === 0) {
    await persistAndSend({
      conversationId,
      taskId,
      content: '[OpenClaw config error] No gateway endpoints configured for this connection',
    })
    return
  }

  const message = (args.message ?? '').trim()
  if (message === '') {
    await persistAndSend({
      conversationId,
      taskId,
      content: '[OpenClaw call error] Message content is empty',
    })
    return
  }

  // Model priority: explicit args.model > connection-level config.openclawModel > default.
  const connectionModel =
    typeof config.openclawModel === 'string' && config.openclawModel.trim() !== ''
      ? config.openclawModel.trim()
      : undefined
  const model = args.model?.trim() || connectionModel || DEFAULT_MODEL

  const ordered = shuffleEndpoints(endpoints)
  const failures: Array<{ label: string; reason: string }> = []

  for (const ep of ordered) {
    const attempt = await invokeEndpoint(ep, message, model)
    if (attempt.ok) {
      await persistAndSend({ conversationId, taskId, content: attempt.content })
      return
    }
    failures.push({ label: ep.label, reason: attempt.reason })
    if (!attempt.retryable) {
      // 4xx etc. — same credentials, deterministic failure on other nodes too.
      break
    }
  }

  const content = formatAggregatedFailure(failures)
  await persistAndSend({ conversationId, taskId, content })
}

/** Shape guard for an `OpenclawEndpoint`. Drops malformed entries silently. */
function isValidEndpoint(entry: unknown): entry is OpenclawEndpoint {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.label === 'string' &&
    e.label.length > 0 &&
    typeof e.url === 'string' &&
    e.url.length > 0 &&
    typeof e.token === 'string' &&
    e.token.length > 0
  )
}

/** Fisher–Yates shuffle producing a new array (does not mutate the input). */
function shuffleEndpoints(eps: readonly OpenclawEndpoint[]): OpenclawEndpoint[] {
  const out = [...eps]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Invoke a single endpoint via POST /v1/chat/completions and classify the
 * outcome. Stateless: each call generates a fresh OpenClaw session on the
 * gateway side (no conversation continuity expected — CrewMeld's own LLM
 * already manages the user-facing chat history).
 */
async function invokeEndpoint(
  ep: OpenclawEndpoint,
  message: string,
  model: string
): Promise<EndpointAttempt> {
  const endpoint = `${ep.url.replace(/\/+$/, '')}/v1/chat/completions`
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ep.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
    })

    if (res.ok) {
      const payload = (await res.json()) as Record<string, unknown>
      return { ok: true, content: formatOpenclawResult(payload) }
    }

    const bodyText = await safeReadText(res)
    const excerpt = bodyText.slice(0, 200)
    const reason = excerpt ? `HTTP ${res.status}: ${excerpt}` : `HTTP ${res.status}`
    // Each endpoint has its own token + gateway config (e.g. one may have
    // chatCompletions enabled, another not), so failures like 401/403/404 are
    // node-specific — fall over to the next endpoint. Only short-circuit on
    // request-body errors (400 Bad Request, 422 Unprocessable Entity) that
    // would re-fail on every node with the same payload.
    const retryable = res.status !== 400 && res.status !== 422
    return { ok: false, reason, retryable }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const lower = errMsg.toLowerCase()
    const isTimeout =
      lower.includes('abort') ||
      lower.includes('timeout') ||
      (err instanceof Error && err.name === 'TimeoutError')
    const reason = isTimeout ? 'timeout' : `call failed: ${errMsg}`
    return { ok: false, reason, retryable: true }
  }
}

/** Build the aggregated assistant message when all endpoints fail. */
function formatAggregatedFailure(failures: Array<{ label: string; reason: string }>): string {
  const lines = failures.map((f) => `- ${f.label}: ${f.reason}`).join('\n')
  return `[OpenClaw all gateways failed]\n${lines}`
}

/** Best-effort `Response.text()` that never throws. */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Insert one assistant message row + push to the bound IM channel.
 *
 * Channel send failures are logged but do not throw — DB persistence is the
 * source of truth, IM delivery is best-effort.
 */
async function persistAndSend(opts: {
  conversationId: string
  taskId: string
  content: string
}): Promise<void> {
  const { conversationId, taskId, content } = opts

  await db.insert(conversationMessages).values({
    id: uuidv4(),
    conversationId,
    role: 'assistant',
    content,
    metadata: { openclawTaskId: taskId, source: 'openclaw-async' },
  })

  const sessions = await db
    .select({
      channel: channelSessions.channel,
      externalUserId: channelSessions.externalUserId,
      externalSessionId: channelSessions.externalSessionId,
      employeeId: channelSessions.employeeId,
    })
    .from(channelSessions)
    .where(eq(channelSessions.conversationId, conversationId))
    .limit(1)

  if (sessions.length === 0) {
    logger.warn('No channel session bound to conversation; skipping IM push', {
      conversationId,
      taskId,
    })
    return
  }
  const cs = sessions[0]

  const plugin = getPlugin(cs.channel)
  if (!plugin) {
    logger.warn('Channel plugin not registered; skipping IM push', {
      conversationId,
      channel: cs.channel,
      taskId,
    })
    return
  }

  try {
    const { resolveCredentialByBoundEmployee, resolveSystemDefault } = await import(
      '@/lib/connectors/resolver'
    )
    type ConnType = Parameters<typeof resolveSystemDefault>[0]
    const channelAsConnType = cs.channel as unknown as ConnType
    const credential =
      (await resolveCredentialByBoundEmployee(cs.employeeId, channelAsConnType)) ??
      (await resolveSystemDefault(channelAsConnType))

    if (!credential) {
      logger.warn('No channel credential available; skipping IM push', {
        conversationId,
        channel: cs.channel,
        taskId,
      })
      return
    }

    const receiveId = cs.externalSessionId ?? cs.externalUserId
    await plugin.outbound.sendText(
      { receiveId, content },
      credential.config as Record<string, unknown>
    )
  } catch (sendErr) {
    logger.error('Channel send failed (non-fatal)', {
      conversationId,
      channel: cs.channel,
      taskId,
      error: sendErr instanceof Error ? sendErr.message : String(sendErr),
    })
  }
}
