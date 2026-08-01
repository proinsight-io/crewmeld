'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '@crewmeld/logger'
import { mutate as globalMutate } from 'swr'
import { safeRandomUUID } from '@/lib/uuid'
import { useTranslation } from '@/hooks/use-translation'

const logger = createLogger('use-opencode-stream')

/** A single opencode message part (text, tool call, tool result, etc.). */
export interface OpencodePart {
  id: string
  type: string
  text?: string
  tool?: string
  state?: unknown
  [k: string]: unknown
}

/** A full opencode UI message with aggregated parts. */
export interface OpencodeUiMessage {
  id: string
  role: 'user' | 'assistant'
  aborted?: boolean
  parts: OpencodePart[]
}

/** A permission request that is waiting for operator reply. */
export interface OpencodePendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

/** A single option in an opencode question. */
export interface OpencodeQuestionOption {
  label: string
  description: string
}

/** A single question item within a `question.asked` event. */
export interface OpencodeQuestionInfo {
  question: string
  header: string
  options: OpencodeQuestionOption[]
  multiple?: boolean
  /** When false, no custom free-text input is shown; defaults to true. */
  custom?: boolean
}

/** A pending question request waiting for operator answers. */
export interface OpencodePendingQuestion {
  id: string
  sessionID: string
  questions: OpencodeQuestionInfo[]
  /**
   * Workspace directory the question was raised in, taken from the top-level
   * `directory` of the `/global/event` frame. opencode's question routes are
   * NOT session-scoped, so the reply/reject MUST carry this back as the
   * `directory` query param or the request lands in the wrong (empty) Location
   * on multi-workspace deployments (k8s control-plane) and 404s. Mirrors what
   * the opencode TUI does (`question.reply({ requestID, directory, answers })`).
   */
  directory?: string
  /**
   * Workspace id from the same frame. Required on k8s control-plane deployments
   * to proxy the reply/reject to the remote workspace Location holding the
   * pending question (`directory` alone stays on the control-plane). Absent on
   * single-workspace deployments.
   */
  workspace?: string
}

/**
 * A single todo item as broadcast by opencode's `todo.updated` event.
 * The `status` values mirror opencode's TaskTool enum: pending / in_progress / completed / cancelled.
 */
export interface OpencodeTodo {
  content: string
  status: string
  priority?: string
}

/**
 * Server-driven retry state, mirrored from opencode's `session.status` event
 * (`type: "retry"`). opencode 1.17.x retries transient provider failures (5xx,
 * overloaded, retry-after) server-side and pushes progress here; the UI reflects
 * it as a banner instead of appearing frozen while a turn is being re-attempted.
 */
export interface OpencodeRetryStatus {
  /** 1-based attempt number reported by opencode. */
  attempt: number
  /** Human-readable reason (e.g. "Provider is overloaded"); may be English. */
  message: string
  /** Epoch milliseconds when the next attempt fires — drives the countdown. */
  next: number
}

/** Return value of {@link useOpencodeStream}. */
export interface UseOpencodeStreamResult {
  messages: OpencodeUiMessage[]
  busy: boolean
  /**
   * True once the SSE stream is open and delivering frames. The chat input is
   * gated on this so a prompt is never sent into a void while the socket is
   * down (a fresh sandbox whose opencode server is still booting, or a dropped
   * connection mid-reconnect) — those frames would otherwise be missed live.
   */
  connected: boolean
  send: (text: string) => void
  replyPermission: (reply: 'once' | 'always' | 'reject') => void
  pendingPermission: OpencodePendingPermission | null
  /** Pending structured question from `question.asked`, or null when none. */
  pendingQuestion: OpencodePendingQuestion | null
  /** Submit answers for the current pending question; one string[] per question in order. */
  answerQuestion: (answers: string[][]) => void
  /** Dismiss (reject) the current pending question without answering. */
  dismissQuestion: () => void
  /** Last session-level error (e.g. an upstream LLM 404), surfaced to the UI; null when none. */
  error: string | null
  /** Live todo list from the most recent `todo.updated` SSE event. */
  todos: OpencodeTodo[]
  /**
   * Non-null while opencode is retrying the current turn server-side
   * (`session.status: retry`); null when idle/busy. Lets the UI show a retry
   * banner instead of looking dead during an upstream-provider back-off.
   */
  retryStatus: OpencodeRetryStatus | null
  /** Re-fetch persisted history (e.g. after a container comes up post-rehydrate). */
  reloadHistory: () => void
}

/**
 * Pull a human-readable message out of a `session.error` event's payload. The
 * error shape varies (ProviderAuthError / ApiError / UnknownError ...); we prefer
 * a nested provider message + status, then fall back to name or a JSON dump so
 * the operator always sees *something* instead of a silent failure.
 */
function extractSessionErrorMessage(properties: unknown, unknownFallback: string): string {
  const p = (properties ?? {}) as { error?: unknown }
  const err = p.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as {
      name?: string
      message?: string
      data?: { message?: string; statusCode?: number; metadata?: { url?: string } }
    }
    const inner = e.data
    const parts: string[] = []
    if (inner?.message) parts.push(inner.message)
    else if (e.message) parts.push(e.message)
    else if (e.name) parts.push(e.name)
    if (inner?.statusCode) parts.push(`(HTTP ${inner.statusCode})`)
    if (inner?.metadata?.url) parts.push(inner.metadata.url)
    if (parts.length > 0) return parts.join(' ')
    try {
      return JSON.stringify(err)
    } catch {
      return unknownFallback
    }
  }
  return unknownFallback
}

/**
 * Heartbeat watchdog timeout in milliseconds. opencode emits `server.heartbeat`
 * every ~10s, but a buffering reverse proxy can deliver frames in bursts; a tight
 * timeout then forces a reconnect right as the buffer would flush, producing a
 * "stall → burst → stall" cycle. Keep this well above the heartbeat interval and
 * rely on the browser's native EventSource reconnect for genuinely dead sockets.
 */
const HEARTBEAT_TIMEOUT_MS = 60_000

/**
 * Minimum content-frame idle window (milliseconds) that must elapse before the
 * /messages-stability busy fallback is allowed to fire. Any non-heartbeat SSE
 * frame (message delta, tool progress, todo update, etc.) resets this clock,
 * proving the AI is still actively producing output even when the REST
 * `/messages` snapshot happens to be momentarily stable (e.g. during a silent
 * tool execution or first-token wait). Only when both conditions are true —
 * `/messages` unchanged for ~30 s AND no content frame for this long — does the
 * fallback clear busy.
 */
const CONTENT_IDLE_BEFORE_CLEAR_MS = 15_000

/**
 * Freshness window for the `/question` resilience poll. The poll only exists to
 * recover a `question.asked` event the SSE stream dropped — so when a live frame
 * arrived within this window the SSE is proven healthy and the poll is skipped.
 * Gated on SSE liveness rather than `busy`, because a turn blocked on a pending
 * question produces no tokens and the messages-poll can wrongly flip `busy` to
 * false right when a dropped question most needs recovering.
 */
const SSE_FRESH_WINDOW_MS = 5_000

/**
 * Upsert a message shell by id into the messages list.
 * If the message exists, its role is preserved; otherwise a new shell is created.
 */
function upsertMessage(
  prev: OpencodeUiMessage[],
  id: string,
  role: 'user' | 'assistant'
): OpencodeUiMessage[] {
  const idx = prev.findIndex((m) => m.id === id)
  if (idx >= 0) {
    // Already exists — preserve existing parts
    return prev
  }
  return [...prev, { id, role, parts: [] }]
}

/**
 * Upsert a part into the message identified by messageID.
 * Parts are keyed by part.id.
 */
function upsertPart(
  prev: OpencodeUiMessage[],
  messageID: string,
  part: OpencodePart
): OpencodeUiMessage[] {
  return prev.map((m) => {
    if (m.id !== messageID) return m
    const idx = m.parts.findIndex((p) => p.id === part.id)
    if (idx >= 0) {
      const updated = [...m.parts]
      updated[idx] = { ...updated[idx], ...part }
      return { ...m, parts: updated }
    }
    return { ...m, parts: [...m.parts, part] }
  })
}

/**
 * Append a delta value to the named field of a specific part.
 */
function applyPartDelta(
  prev: OpencodeUiMessage[],
  messageID: string,
  partID: string,
  field: string,
  delta: string
): OpencodeUiMessage[] {
  return prev.map((m) => {
    if (m.id !== messageID) return m
    const parts = m.parts.map((p) => {
      if (p.id !== partID) return p
      const current = typeof p[field] === 'string' ? (p[field] as string) : ''
      return { ...p, [field]: current + delta }
    })
    return { ...m, parts }
  })
}

/**
 * Remove a part from a message by id.
 */
function removePart(
  prev: OpencodeUiMessage[],
  messageID: string,
  partID: string
): OpencodeUiMessage[] {
  return prev.map((m) => {
    if (m.id !== messageID) return m
    return { ...m, parts: m.parts.filter((p) => p.id !== partID) }
  })
}

/**
 * React hook that connects to the opencode BFF SSE stream for a given session.
 *
 * - Fetches persisted message history on sessionId change.
 * - Opens an EventSource to receive live events.
 * - Applies event reducer to aggregate messages/parts.
 * - Implements a 15-second heartbeat watchdog to reconnect on stale connections.
 * - Exposes send/replyPermission actions.
 *
 * @param sessionId - The active opencode session identifier.
 */
export function useOpencodeStream(sessionId: string): UseOpencodeStreamResult {
  const [messages, setMessages] = useState<OpencodeUiMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<OpencodePendingPermission | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<OpencodePendingQuestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [todos, setTodos] = useState<OpencodeTodo[]>([])
  const [retryStatus, setRetryStatus] = useState<OpencodeRetryStatus | null>(null)
  const { t } = useTranslation()

  // Tracks the opencode-native session id (e.g. "ses_abc") returned by the
  // /messages history endpoint. Used to drop SSE frames that originate from
  // child sub-sessions spawned by the `task` tool so they never render in the
  // main chat. Null when the id is not yet known (no filtering applied).
  const opencodeSessionIdRef = useRef<string | null>(null)

  // Keep a ref to the current pending permission for use in replyPermission callback
  const pendingPermissionRef = useRef<OpencodePendingPermission | null>(null)
  pendingPermissionRef.current = pendingPermission

  // Keep a ref to the current pending question to avoid stale closures in callbacks
  const pendingQuestionRef = useRef<OpencodePendingQuestion | null>(null)
  pendingQuestionRef.current = pendingQuestion

  // Track the last question id that was answered or dismissed to avoid re-adopting it.
  const lastAnsweredQuestionIdRef = useRef<string | null>(null)

  // Latest workspace directory seen on a `/global/event` frame. opencode's
  // non-session-scoped routes (question list/reply/reject) need this as the
  // `directory` query param to reach the session's Location on multi-workspace
  // deployments; every global-event frame carries it at the top level.
  const directoryRef = useRef<string | null>(null)

  // Latest workspace id seen on a `/global/event` frame. On k8s control-plane
  // (multi-workspace) deployments the question is registered in a REMOTE
  // workspace Location; `directory` alone keeps the request on the control-plane
  // Location, so the `workspace` query param is what actually proxies the
  // list/reply/reject to the workspace holding the pending question. Absent on
  // single-workspace (local docker) deployments, where `directory` suffices.
  const workspaceRef = useRef<string | null>(null)

  // Wall-clock of the last SSE frame received (any type, including heartbeat).
  // Drives the `/question` poll's freshness gate so the poll is skipped while
  // the stream is demonstrably live.
  const lastFrameAtRef = useRef(0)
  // Wall-clock of the last non-heartbeat SSE frame received (message deltas,
  // tool progress, todo updates, permission/question events, etc.). Used by the
  // /messages busy fallback to distinguish real AI activity from a merely stable
  // REST snapshot. Heartbeats intentionally do NOT update this ref.
  const lastContentFrameAtRef = useRef(0)
  // Heartbeat watchdog timer ref
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Fast-reopen timer + attempt counter for the CLOSED-socket recovery path.
  // The browser does not natively reconnect a CLOSED EventSource, so we reopen
  // it ourselves with a capped exponential backoff instead of waiting out the
  // 60s heartbeat watchdog.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  // Latch: true once a <title> has been persisted for the current session.
  // Resets to false on sessionId change so each session gets exactly one persist.
  const titlePersistedRef = useRef<boolean>(false)
  // EventSource ref for cleanup
  const esRef = useRef<EventSource | null>(null)
  // Ref to the current sessionId to detect stale handlers
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Ref to the AbortController for the most recent reloadHistory fetch so that
  // a session switch or a rapid second reload can abort the in-flight request.
  const reloadAbortRef = useRef<AbortController | null>(null)

  const base = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}`

  // Fetch persisted history into the message list. Extracted from the mount
  // effect so it can also be re-run after a rehydrate/fork brings a container
  // up, swapping the on-disk snapshot for the live REST timeline.
  const fetchHistory = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`${base}/messages`, { signal })
        if (!res.ok) return
        const data = (await res.json()) as {
          messages?: OpencodeUiMessage[]
          opencodeSessionId?: string | null
        }
        if (data.opencodeSessionId != null) {
          opencodeSessionIdRef.current = data.opencodeSessionId
        }
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages)
        }
      } catch (err) {
        // Swallow AbortError quietly — the caller cancelled a stale fetch on cleanup.
        if (err instanceof Error && err.name === 'AbortError') return
        logger.error('Failed to fetch opencode message history', err)
      }
    },
    [base]
  )

  const reloadHistory = useCallback(() => {
    reloadAbortRef.current?.abort()
    const controller = new AbortController()
    reloadAbortRef.current = controller
    void fetchHistory(controller.signal)
  }, [fetchHistory])

  /**
   * Open an EventSource for the current session and register the onmessage handler.
   * Returns a cleanup function that closes the connection.
   */
  const openEventSource = useCallback(
    (currentSessionId: string): (() => void) => {
      // Guard for SSR environments where EventSource is not available
      if (typeof EventSource === 'undefined') {
        return () => {}
      }

      const eventsUrl = `/api/employee/dev-studio/sessions/${encodeURIComponent(currentSessionId)}/events`
      const es = new EventSource(eventsUrl)
      esRef.current = es

      es.onopen = () => {
        if (sessionIdRef.current === currentSessionId) {
          // A successful open clears the backoff and unblocks the input.
          const wasReconnect = reconnectAttemptsRef.current > 0
          reconnectAttemptsRef.current = 0
          lastFrameAtRef.current = Date.now()
          setConnected(true)
          // Diagnostic: confirms the SSE proxy connected for this session.
          logger.info('opencode SSE connected', { sessionId: currentSessionId })
          // Re-bootstrap after a genuine reconnect (not the first open): message
          // parts, todo, or a session.status frame may have been missed while the
          // socket was down. Re-pull the persisted timeline to resync history so
          // the UI doesn't show a truncated turn. Mirrors opencode's own frontend,
          // which re-fetches session state on (re)connect. (Busy/idle self-heals
          // via the session.status handler + the /messages stability fallback.)
          if (wasReconnect) reloadHistory()
        }
      }

      /** Reset the 15-second reconnect timer on every received frame. */
      const resetHeartbeat = () => {
        if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current)
        heartbeatTimerRef.current = setTimeout(() => {
          // No frame for 15s — close and reopen
          if (sessionIdRef.current === currentSessionId) {
            es.close()
            openEventSource(currentSessionId)
          }
        }, HEARTBEAT_TIMEOUT_MS)
      }

      resetHeartbeat()

      // Reopen a dead socket with a capped exponential backoff (2s, 4s, 8s,
      // 15s cap). The browser will not reconnect a CLOSED EventSource on its
      // own, and a single transient /events 502 (opencode still booting in a
      // fresh sandbox) would otherwise stall the turn until the 60s watchdog
      // fires. Idempotent: a second onerror while a reopen is already pending
      // is ignored.
      const scheduleReopen = () => {
        if (reconnectTimerRef.current) return
        const attempt = reconnectAttemptsRef.current
        const delay = Math.min(2000 * 2 ** attempt, 15_000)
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          if (sessionIdRef.current !== currentSessionId) return
          reconnectAttemptsRef.current = attempt + 1
          es.close()
          openEventSource(currentSessionId)
        }, delay)
      }

      es.onmessage = (e: MessageEvent) => {
        // Stale handler guard: session changed while this ES was open
        if (sessionIdRef.current !== currentSessionId) return

        resetHeartbeat()
        // Receiving any frame proves the stream is live — unblock the input
        // even if `onopen` was not delivered (some proxies skip it).
        lastFrameAtRef.current = Date.now()
        setConnected(true)

        let frame: {
          directory?: string
          workspace?: string
          payload?: { type?: string; properties?: Record<string, unknown> }
        }
        try {
          frame = JSON.parse(e.data) as typeof frame
        } catch (err) {
          logger.error('Failed to parse SSE frame', err)
          return
        }

        // Capture the workspace directory + id carried on every global-event
        // frame so the non-session-scoped question routes can be routed back to
        // the right Location (see directoryRef / workspaceRef / answerQuestion).
        if (typeof frame.directory === 'string' && frame.directory) {
          directoryRef.current = frame.directory
        }
        if (typeof frame.workspace === 'string' && frame.workspace) {
          workspaceRef.current = frame.workspace
        }

        const { type, properties } = frame.payload ?? {}
        if (!type) return

        // Diagnostic: log every business frame type (skip the 10s heartbeat noise)
        // so we can see what opencode actually emits for a turn.
        if (type !== 'server.heartbeat') {
          logger.info('opencode SSE frame', {
            type,
            sessionID: (properties as { sessionID?: string } | undefined)?.sessionID,
          })
        }

        // Sub-session filter: opencode's /global/event SSE stream carries frames
        // from ALL sessions including child sub-sessions spawned by the `task` tool.
        // Drop any frame whose sessionID does not match the main session id we
        // captured from the /messages history response. Frames without a sessionID
        // (server.connected, server.heartbeat) are never filtered.
        const evSessionID = (properties as { sessionID?: string } | undefined)?.sessionID
        if (
          opencodeSessionIdRef.current &&
          evSessionID &&
          evSessionID !== opencodeSessionIdRef.current
        ) {
          return
        }

        // Refresh the content-frame liveness clock for any real activity frame.
        // server.heartbeat only proves the socket is alive — it carries no AI
        // output, so it must NOT reset the content clock.
        if (type !== 'server.heartbeat') {
          lastContentFrameAtRef.current = Date.now()
        }

        switch (type) {
          case 'message.updated': {
            const info = properties?.info as
              | { id?: string; role?: 'user' | 'assistant' }
              | undefined
            if (info?.id && info.role) {
              setMessages((prev) =>
                upsertMessage(prev, info.id as string, info.role as 'user' | 'assistant')
              )
            }
            break
          }
          case 'message.part.updated': {
            const part = properties?.part as OpencodePart | undefined
            if (part?.id && part.messageID) {
              setMessages((prev) => upsertPart(prev, part.messageID as string, part))
            }
            break
          }
          case 'message.part.delta': {
            const { messageID, partID, field, delta } = (properties ?? {}) as {
              messageID?: string
              partID?: string
              field?: string
              delta?: string
            }
            if (messageID && partID && field && typeof delta === 'string') {
              setMessages((prev) => applyPartDelta(prev, messageID, partID, field, delta))
            }
            break
          }
          case 'message.part.removed': {
            const { messageID, partID } = (properties ?? {}) as {
              messageID?: string
              partID?: string
            }
            if (messageID && partID) {
              setMessages((prev) => removePart(prev, messageID, partID))
            }
            break
          }
          case 'permission.asked': {
            const { id, sessionID, permission, patterns } = (properties ?? {}) as {
              id?: string
              sessionID?: string
              permission?: string
              patterns?: string[]
            }
            if (id && sessionID && permission && patterns) {
              setPendingPermission({ id, sessionID, permission, patterns })
            }
            break
          }
          case 'permission.replied': {
            setPendingPermission(null)
            break
          }
          // opencode 1.17.x publishes these as `question.v2.*` on the global
          // event bus. The legacy `question.*` names are kept as fall-through so
          // a version skew in the sandbox image still surfaces the card.
          case 'question.asked':
          case 'question.v2.asked': {
            const { id, sessionID, questions } = (properties ?? {}) as {
              id?: string
              sessionID?: string
              questions?: OpencodeQuestionInfo[]
            }
            if (id && sessionID && Array.isArray(questions)) {
              setPendingQuestion({
                id,
                sessionID,
                questions,
                directory: directoryRef.current ?? undefined,
                workspace: workspaceRef.current ?? undefined,
              })
            }
            break
          }
          case 'question.replied':
          case 'question.rejected':
          case 'question.v2.replied':
          case 'question.v2.rejected': {
            setPendingQuestion(null)
            break
          }
          // opencode 1.17.x unified busy/idle/retry into a single `session.status`
          // event and is the authoritative source of turn state. `session.idle`
          // (below) is still emitted for back-compat, but only `session.status`
          // carries the `retry` phase — without handling it, the UI looks frozen
          // while opencode is retrying an overloaded/5xx provider server-side.
          case 'session.status': {
            const status = (properties?.status ?? {}) as {
              type?: 'idle' | 'busy' | 'retry'
              attempt?: number
              message?: string
              next?: number
            }
            if (status.type === 'retry') {
              setBusy(true)
              setRetryStatus({
                attempt: typeof status.attempt === 'number' ? status.attempt : 0,
                message: typeof status.message === 'string' ? status.message : '',
                next: typeof status.next === 'number' ? status.next : 0,
              })
            } else if (status.type === 'busy') {
              setBusy(true)
              setRetryStatus(null)
            } else if (status.type === 'idle') {
              setBusy(false)
              setRetryStatus(null)
            }
            break
          }
          case 'session.idle': {
            setBusy(false)
            setRetryStatus(null)
            break
          }
          case 'session.error': {
            setBusy(false)
            setRetryStatus(null)
            setError(extractSessionErrorMessage(properties, t('devStudio.opencode.error.unknown')))
            logger.error('opencode session error', properties)
            break
          }
          case 'todo.updated': {
            const rawTodos = (properties?.todos ?? []) as OpencodeTodo[]
            setTodos(rawTodos)
            break
          }
          default:
            break
        }
      }

      es.onerror = () => {
        if (sessionIdRef.current !== currentSessionId) return
        // The browser fires onerror on every transient drop and then reconnects
        // on its own (readyState CONNECTING). A CLOSED socket is dead: the
        // browser will NOT reconnect it, so we reopen it ourselves with backoff
        // instead of waiting out the 60s heartbeat watchdog.
        if (es.readyState === EventSource.CLOSED) {
          setConnected(false)
          logger.warn('opencode EventSource closed; scheduling fast reopen')
          scheduleReopen()
        } else {
          logger.info('opencode EventSource reconnecting (transient)')
        }
      }

      return () => {
        if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current)
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        es.close()
        // A reopen (heartbeat watchdog or backoff) may have swapped esRef to a
        // newer socket than the `es` this cleanup closed over; close that one
        // too so a reconnect in flight at unmount does not leak a connection.
        if (esRef.current && esRef.current !== es) {
          esRef.current.close()
        }
        esRef.current = null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Main effect: reset state, fetch history, open EventSource on sessionId change
  useEffect(() => {
    setMessages([])
    setBusy(false)
    setPendingPermission(null)
    setPendingQuestion(null)
    setError(null)
    setTodos([])
    setRetryStatus(null)
    // Reset the session-filter ref when the session changes so stale ids from a
    // previous session do not filter frames for the newly selected session.
    opencodeSessionIdRef.current = null
    // Reset the content-frame clock so a stale timestamp from the previous
    // session cannot block the busy fallback for the new session.
    lastContentFrameAtRef.current = 0
    // A new session starts disconnected until its SSE opens; reset the backoff
    // so the first reopen for this session uses the shortest delay.
    setConnected(false)
    reconnectAttemptsRef.current = 0
    // Reset the title-persistence latch so the new session can emit its own title.
    titlePersistedRef.current = false

    // Fetch persisted history to seed messages; aborted on cleanup so a stale
    // in-flight request for an old sessionId cannot corrupt the new session's state.
    const controller = new AbortController()
    void fetchHistory(controller.signal)

    // Open SSE connection
    const cleanup = openEventSource(sessionId)

    return () => {
      controller.abort()
      reloadAbortRef.current?.abort()
      cleanup()
    }
  }, [sessionId, base, openEventSource, fetchHistory])

  // Resilience fallback: a buffering/dropping SSE stream (Next.js dev buffering,
  // a reconnect that does not replay in-flight deltas, a k8s idle drop) can leave
  // the reply stalled mid-sentence. While a turn is in flight (busy), poll the
  // REST messages endpoint — a short-lived request immune to SSE buffering — and
  // overwrite local messages with the authoritative server state, so a stalled
  // half-sentence gets completed. Stop when content stops changing (the SSE
  // `session.idle` that would clear busy may itself be buffered/lost).
  useEffect(() => {
    if (!busy) return
    let cancelled = false
    let lastSerialized = ''
    let stable = 0
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`${base}/messages`)
          if (cancelled || !res.ok) return
          const data = (await res.json()) as {
            messages?: OpencodeUiMessage[]
            opencodeSessionId?: string | null
          }
          // Keep the session-filter ref up-to-date if the poll response carries
          // the opencode session id. Never overwrite a known id with null.
          if (data.opencodeSessionId != null) {
            opencodeSessionIdRef.current = data.opencodeSessionId
          }
          const msgs = data.messages ?? []
          if (cancelled) return
          if (msgs.length > 0) setMessages(msgs)
          const serialized = JSON.stringify(msgs)
          if (serialized === lastSerialized) {
            stable += 1
            // ~30s with no change → treat the turn as finished even if the SSE
            // `session.idle` event was lost, so busy does not stay stuck forever.
            // This window must stay well above the model's first-token latency:
            // a tighter cutoff (the old ~9s) made the poll give up while the
            // model was still thinking, so a reply on a dropped SSE socket only
            // appeared after the 60s watchdog reopened the stream.
            //
            // ALSO require that no content frame arrived within the last
            // CONTENT_IDLE_BEFORE_CLEAR_MS: a long-running tool execution or
            // silent thinking phase emits SSE frames (tool-state, todo.updated,
            // message.part.delta) without changing the REST /messages snapshot,
            // so a stable snapshot alone is not a reliable idle signal.
            if (
              stable >= 20 &&
              Date.now() - lastContentFrameAtRef.current >= CONTENT_IDLE_BEFORE_CLEAR_MS
            ) {
              setBusy(false)
            }
          } else {
            stable = 0
            lastSerialized = serialized
          }
        } catch {
          // Ignore transient poll errors; the next tick retries.
        }
      })()
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [busy, base])

  // Resilience fallback: poll GET /question every 3s so that a `question.asked`
  // SSE event that was buffered or dropped still surfaces the question card.
  // The poll only ADOPTS a new pending question; it never clears one (the SSE
  // `question.replied` / `question.rejected` events own that responsibility).
  useEffect(() => {
    let cancelled = false
    const timer = setInterval(() => {
      // SSE-freshness gate: skip the poll while the stream is demonstrably live
      // (a frame arrived within the window). The SSE `question.asked` event is
      // the primary channel; this poll only backstops a dropped/buffered one.
      if (Date.now() - lastFrameAtRef.current < SSE_FRESH_WINDOW_MS) return
      void (async () => {
        try {
          // Forward the workspace directory so the BFF can route the (non
          // session-scoped) opencode question list to the right Location on
          // multi-workspace deployments; without it list() returns empty there.
          const dir = directoryRef.current
          const ws = workspaceRef.current
          const params = new URLSearchParams()
          if (dir) params.set('directory', dir)
          if (ws) params.set('workspace', ws)
          const qs = params.toString()
          const res = await fetch(qs ? `${base}/question?${qs}` : `${base}/question`)
          if (cancelled || !res.ok) return
          const data = (await res.json()) as { questions?: OpencodePendingQuestion[] }
          if (cancelled) return
          const questions = data.questions ?? []
          // Pick the first question that has not already been answered/dismissed.
          const found = questions.find((q) => q.id !== lastAnsweredQuestionIdRef.current)
          if (found) {
            // Stamp the routing hints so a subsequent reply/reject routes correctly.
            const withDir: OpencodePendingQuestion = {
              ...found,
              directory: found.directory ?? dir ?? undefined,
              workspace: found.workspace ?? ws ?? undefined,
            }
            setPendingQuestion((cur) => (cur?.id === withDir.id ? cur : withDir))
          }
        } catch {
          // Ignore transient poll errors; next tick retries.
        }
      })()
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [base])

  // Scan assistant messages for a <title>…</title> marker and persist it to the
  // session record exactly once per session. The server only writes the title when
  // the stored value is null, so re-sending on history reload is safe (no-op).
  useEffect(() => {
    if (titlePersistedRef.current) return
    const TITLE_RE = /<title>([\s\S]*?)<\/title>/
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const part of msg.parts) {
        if (typeof part.text !== 'string') continue
        const match = TITLE_RE.exec(part.text)
        if (!match) continue
        const title = match[1].trim()
        if (!title) continue
        // Latch immediately so subsequent renders triggered by deltas do not
        // queue another PATCH before the first async one has even completed.
        titlePersistedRef.current = true
        void (async () => {
          try {
            const res = await fetch(base, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title }),
            })
            if (res.ok) {
              // Revalidate all sessions-list SWR keys so the SessionSwitcher
              // sidebar updates immediately without waiting for its 60s poll.
              void globalMutate(
                (key) =>
                  typeof key === 'string' && key.startsWith('/api/employee/dev-studio/sessions')
              )
            }
          } catch (err) {
            logger.warn('Failed to persist opencode session title', err)
          }
        })()
        return
      }
    }
  }, [messages, base])

  /**
   * Send a prompt to the session.
   * Sets busy=true immediately and POST to /chat.
   */
  const send = useCallback(
    (text: string) => {
      setBusy(true)
      setError(null)
      setRetryStatus(null)
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // requestId satisfies the shared strict ChatRequestSchema (required uuid).
        // The opencode BFF branch ignores it — the assistant reply streams back
        // over SSE, not in this response. Use safeRandomUUID (not crypto.randomUUID,
        // which is undefined in insecure-context/HTTP deploys).
        body: JSON.stringify({ message: text, requestId: safeRandomUUID() }),
      })
        .then(async (res) => {
          // The opencode /chat branch returns 202 on success; surface non-ok
          // responses (e.g. 400/502) instead of leaving busy stuck true.
          if (!res.ok) {
            const detail = await res
              .json()
              .then((b: { error?: string; detail?: string }) => b.detail ?? b.error)
              .catch(() => undefined)
            logger.error('opencode /chat returned non-ok', { status: res.status, detail })
            const base = t('devStudio.opencode.error.sendFailedHttp', { status: res.status })
            setError(detail ? `${base}${t('devStudio.opencode.error.detailSep')}${detail}` : base)
            setBusy(false)
          }
        })
        .catch((err: unknown) => {
          logger.error('Failed to send message to opencode session', err)
          setError(
            `${t('devStudio.opencode.error.sendFailed')}${t('devStudio.opencode.error.detailSep')}${String(err)}`
          )
          setBusy(false)
        })
    },
    [base, t]
  )

  /**
   * Reply to the currently pending permission request.
   * Clears pendingPermission immediately and POST to /permission.
   */
  const replyPermission = useCallback(
    (reply: 'once' | 'always' | 'reject') => {
      const pending = pendingPermissionRef.current
      if (!pending) return
      // Clear immediately — optimistic update
      setPendingPermission(null)
      // Granting permission resumes the turn — re-assert busy so the "working"
      // indicator reappears. A reject usually idles quickly, so only the
      // resume cases (once/always) flip it back on. `session.idle` clears it.
      if (reply === 'once' || reply === 'always') setBusy(true)
      fetch(`${base}/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: pending.id, reply }),
      }).catch((err: unknown) => {
        logger.error('Failed to reply to opencode permission request', err)
      })
    },
    [base]
  )

  /**
   * Submit answers for the currently pending question.
   * Optimistically clears the pending question and POSTs to /question.
   *
   * @param answers - One string[] per question in question order.
   */
  const answerQuestion = useCallback(
    (answers: string[][]) => {
      const pending = pendingQuestionRef.current
      if (!pending) return
      // Record before optimistic clear so the poll won't re-adopt this id.
      lastAnsweredQuestionIdRef.current = pending.id
      // Optimistic clear
      setPendingQuestion(null)
      // The agent resumes this turn on the answer — re-assert busy so the
      // "working" indicator reappears immediately instead of leaving a blank
      // gap that reads as a dropped connection. `session.idle` clears it.
      setBusy(true)
      fetch(`${base}/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: pending.id,
          answers,
          directory: pending.directory ?? directoryRef.current ?? undefined,
          workspace: pending.workspace ?? workspaceRef.current ?? undefined,
        }),
      }).catch((err: unknown) => {
        logger.error('Failed to submit opencode question answers', err)
      })
    },
    [base]
  )

  /**
   * Dismiss (reject) the currently pending question without answering.
   * Optimistically clears the pending question and POSTs to /question with reject:true.
   */
  const dismissQuestion = useCallback(() => {
    const pending = pendingQuestionRef.current
    if (!pending) return
    // Record before optimistic clear so the poll won't re-adopt this id.
    lastAnsweredQuestionIdRef.current = pending.id
    // Optimistic clear
    setPendingQuestion(null)
    fetch(`${base}/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: pending.id,
        reject: true,
        directory: pending.directory ?? directoryRef.current ?? undefined,
        workspace: pending.workspace ?? workspaceRef.current ?? undefined,
      }),
    }).catch((err: unknown) => {
      logger.error('Failed to dismiss opencode question', err)
    })
  }, [base])

  return {
    messages,
    busy,
    connected,
    send,
    replyPermission,
    pendingPermission,
    pendingQuestion,
    answerQuestion,
    dismissQuestion,
    error,
    todos,
    retryStatus,
    reloadHistory,
  }
}
