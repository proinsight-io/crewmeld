import { createLogger } from '@crewmeld/logger'

const logger = createLogger('dev-studio:opencode-rest')

export interface OpencodeMessageWithParts {
  info: unknown
  parts: unknown[]
}

type Headers = Record<string, string>

function jsonHeaders(headers: Headers): Headers {
  return { 'content-type': 'application/json', ...headers }
}

/**
 * Append opencode's `auth_token` query param, mirroring the value carried in the
 * incoming `Authorization: Basic <token>` header.
 *
 * The OpenSandbox reverse proxy (useProxy mode) strips the `Authorization`
 * header before forwarding to the in-container opencode server, so header-only
 * auth 401s once traffic goes through the proxy. opencode also accepts the same
 * credentials via an `auth_token` query param — which survives the proxy — and
 * that is exactly what the SSE `/global/event` route already relies on. We
 * derive the token from the header the caller already builds so REST call sites
 * need no signature changes, and keep sending the header too (harmless: it wins
 * in direct mode and is dropped in proxy mode).
 *
 * No-op when no `Authorization` header is present (direct mode without a server
 * password), so an unauthenticated opencode server is unaffected.
 */
function withAuthToken(url: string, headers: Headers): string {
  const auth = headers.Authorization ?? headers.authorization
  const token = auth?.startsWith('Basic ') ? auth.slice('Basic '.length) : undefined
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}auth_token=${encodeURIComponent(token)}`
}

/**
 * Append opencode's `directory` workspace-routing query param.
 *
 * The question routes (`GET /question`, `/question/:id/reply|reject`) are NOT
 * session-scoped, so opencode's WorkspaceRoutingMiddleware falls back to
 * `process.cwd()` unless a `directory` (or `workspace`) query param is present.
 * On multi-workspace deployments (k8s control-plane) that default routes to the
 * wrong Location and the in-memory pending-question map comes back empty, so the
 * list returns nothing and replies 404. Passing the session's directory (sourced
 * from the top-level `directory` on the `/global/event` frame) pins the request
 * to the right Location — exactly what the opencode TUI does.
 *
 * No-op when `directory` is undefined so direct/single-workspace callers are
 * unaffected.
 */
function withDirectory(url: string, directory?: string): string {
  if (!directory) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}directory=${encodeURIComponent(directory)}`
}

/**
 * Append opencode's `workspace` routing query param. On k8s control-plane
 * (multi-workspace) deployments the pending question lives in a REMOTE workspace
 * Location; `directory` alone keeps the request on the control-plane, so
 * `workspace=<id>` is what proxies the list/reply/reject through to that
 * workspace. No-op when undefined (single-workspace / local docker).
 */
function withWorkspace(url: string, workspace?: string): string {
  if (!workspace) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}workspace=${encodeURIComponent(workspace)}`
}

/** Create a fresh opencode session; returns its id. */
export async function createOpencodeSession(
  baseUrl: string,
  headers: Headers
): Promise<{ id: string }> {
  const res = await fetch(withAuthToken(`${baseUrl}/session`, headers), {
    method: 'POST',
    headers: jsonHeaders(headers),
  })
  if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
  const body = (await res.json()) as { id: string }
  return { id: body.id }
}

/** Send a user prompt without blocking; reply streams over SSE. */
export async function promptOpencodeAsync(
  baseUrl: string,
  headers: Headers,
  sessionId: string,
  text: string,
  model?: { providerID: string; modelID: string }
): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: 'text', text }] }
  if (model) body.model = model
  const res = await fetch(
    withAuthToken(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, headers),
    {
      method: 'POST',
      headers: jsonHeaders(headers),
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) throw new Error(`opencode prompt_async failed: ${res.status}`)
}

/** Read message+part history (time ascending). */
export async function listOpencodeMessages(
  baseUrl: string,
  headers: Headers,
  sessionId: string,
  limit?: number
): Promise<OpencodeMessageWithParts[]> {
  const q = limit ? `?limit=${limit}` : ''
  const res = await fetch(
    withAuthToken(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message${q}`, headers),
    { headers }
  )
  if (!res.ok) throw new Error(`opencode list messages failed: ${res.status}`)
  return (await res.json()) as OpencodeMessageWithParts[]
}

/** A pending question request as returned by opencode `GET /question`. */
export interface OpencodeQuestionRequest {
  id: string
  sessionID: string
  questions: unknown[]
}

/**
 * List pending question requests. Used to recover a `question.asked` that the
 * SSE stream may have dropped/buffered, so the question card still appears.
 * Returns the raw opencode requests (the route filters by opencode session).
 */
export async function listOpencodeQuestions(
  baseUrl: string,
  headers: Headers,
  directory?: string,
  workspace?: string
): Promise<OpencodeQuestionRequest[]> {
  const res = await fetch(
    withAuthToken(
      withWorkspace(withDirectory(`${baseUrl}/question`, directory), workspace),
      headers
    ),
    { headers }
  )
  if (!res.ok) throw new Error(`opencode list questions failed: ${res.status}`)
  return (await res.json()) as OpencodeQuestionRequest[]
}

/** Reply to a permission request. */
export async function replyOpencodePermission(
  baseUrl: string,
  headers: Headers,
  requestId: string,
  reply: 'once' | 'always' | 'reject'
): Promise<void> {
  const res = await fetch(
    withAuthToken(`${baseUrl}/permission/${encodeURIComponent(requestId)}/reply`, headers),
    {
      method: 'POST',
      headers: jsonHeaders(headers),
      body: JSON.stringify({ reply }),
    }
  )
  if (!res.ok) {
    logger.warn('opencode permission reply non-ok', { requestId, status: res.status })
    throw new Error(`opencode permission reply failed: ${res.status}`)
  }
}

/**
 * Reply to a question request with the operator's answers.
 *
 * @param baseUrl  - Base URL of the opencode server.
 * @param headers  - Auth + proxy headers.
 * @param requestId - The question request id from the `question.asked` SSE event.
 * @param answers  - One string[] per question (selected option labels or custom free-text).
 */
export async function replyOpencodeQuestion(
  baseUrl: string,
  headers: Headers,
  requestId: string,
  answers: string[][],
  directory?: string,
  workspace?: string
): Promise<void> {
  const res = await fetch(
    withAuthToken(
      withWorkspace(
        withDirectory(`${baseUrl}/question/${encodeURIComponent(requestId)}/reply`, directory),
        workspace
      ),
      headers
    ),
    {
      method: 'POST',
      headers: jsonHeaders(headers),
      body: JSON.stringify({ answers }),
    }
  )
  if (!res.ok) {
    logger.warn('opencode question reply non-ok', { requestId, status: res.status })
    throw new Error(`opencode question reply failed: ${res.status}`)
  }
}

/**
 * Reject (dismiss) a pending question request without answering.
 *
 * @param baseUrl   - Base URL of the opencode server.
 * @param headers   - Auth + proxy headers.
 * @param requestId - The question request id from the `question.asked` SSE event.
 */
export async function rejectOpencodeQuestion(
  baseUrl: string,
  headers: Headers,
  requestId: string,
  directory?: string,
  workspace?: string
): Promise<void> {
  const res = await fetch(
    withAuthToken(
      withWorkspace(
        withDirectory(`${baseUrl}/question/${encodeURIComponent(requestId)}/reject`, directory),
        workspace
      ),
      headers
    ),
    {
      method: 'POST',
      headers: jsonHeaders(headers),
    }
  )
  if (!res.ok) {
    logger.warn('opencode question reject non-ok', { requestId, status: res.status })
    throw new Error(`opencode question reject failed: ${res.status}`)
  }
}
