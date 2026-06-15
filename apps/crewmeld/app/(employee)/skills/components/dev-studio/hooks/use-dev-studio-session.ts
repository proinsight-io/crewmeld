'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate as globalMutate } from 'swr'
import type { SessionRecord } from '@/lib/dev-studio/session-store'

const SESSIONS_URL = '/api/employee/dev-studio/sessions'
const SESSIONS_SWR_KEY_PREFIX = SESSIONS_URL

interface CreateSessionResponse {
  sessionId: string
  status: 'ready'
}

interface ApiError {
  error: string
  detail?: string
  retryable: boolean
}

export type SessionStatus = 'idle' | 'resolving' | 'select-model' | 'creating' | 'ready' | 'error'

export interface UseDevStudioSessionResult {
  sessionId: string | null
  status: SessionStatus
  error: ApiError | null
  retry: () => void
  /**
   * Create a brand-new session pinned to the chosen coding model. Used by the
   * entry model-picker shown when there is nothing to resume — replaces the
   * old behavior of auto-creating with the global-env ("system default") model.
   */
  startWithModel: (modelConfigId: string | null) => void
  /**
   * Swap the currently-displayed session id without creating or destroying
   * a container — used by the header SessionSwitcher to pivot the dialog to
   * a different existing session. The previously-created session row stays
   * in the DB; the caller is responsible for any teardown.
   */
  setSessionId: (id: string) => void
}

/**
 * Optional opts for {@link useDevStudioSession}.
 *
 * `initialSessionId` lets callers (e.g. the SkillsPage when opened via the
 * NotificationCenter's `?devStudio=<id>` query param) hand the dialog a
 * pre-existing session id. When provided the hook skips the resume-or-create
 * roundtrip and pivots straight to `ready` with that id — and crucially does
 * NOT mark it as "owned" so the dialog's destroy effect leaves the session
 * alone on unmount.
 *
 * `toolId` scopes the resume lookup to sessions linked to a specific tool —
 * used by the "develop existing tool" entry so reopening resumes that tool's
 * latest session rather than an unrelated one.
 */
export interface UseDevStudioSessionOptions {
  initialSessionId?: string | null
  toolId?: string
}

export function useDevStudioSession(
  enabled: boolean,
  opts: UseDevStudioSessionOptions = {}
): UseDevStudioSessionResult {
  const { initialSessionId = null, toolId } = opts
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [error, setError] = useState<ApiError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const sessionIdRef = useRef<string | null>(null)
  // Track which session id (if any) was created by this hook instance so the
  // unmount cleanup only destroys our own — never a session the user pivoted
  // or resumed into. Resuming an existing session must leave it alone on close.
  const ownedSessionIdRef = useRef<string | null>(null)

  const create = useCallback(async (signal: AbortSignal, modelConfigId?: string | null) => {
    setStatus('creating')
    setError(null)
    try {
      const res = await fetch(SESSIONS_URL, {
        method: 'POST',
        signal,
        // Only attach a JSON body when a model was explicitly chosen; legacy
        // no-body callers keep the global-env fallback semantics server-side.
        ...(modelConfigId !== undefined
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modelConfigId }),
            }
          : {}),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<ApiError>
        setError({
          error: body.error ?? 'unknown',
          detail: body.detail,
          retryable: body.retryable ?? false,
        })
        setStatus('error')
        return
      }
      const body = (await res.json()) as CreateSessionResponse
      sessionIdRef.current = body.sessionId
      ownedSessionIdRef.current = body.sessionId
      setSessionId(body.sessionId)
      setStatus('ready')
      // The BFF just created a new tool_dev_sessions row with
      // containerStatus='running' — push SWR to pick it up immediately so the
      // header's ConnectionStatus jumps from "已离线" (cache miss) to
      // "运行中" without waiting for the background refresh.
      void globalMutate((key) => typeof key === 'string' && key.startsWith(SESSIONS_SWR_KEY_PREFIX))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError({ error: 'network', detail: String(e), retryable: true })
      setStatus('error')
    }
  }, [])

  /**
   * Pivot into an existing session WITHOUT creating or destroying a container.
   * The id is deliberately kept out of `ownedSessionIdRef` so the unmount
   * cleanup leaves it running in the background.
   */
  const resume = useCallback((id: string) => {
    sessionIdRef.current = id
    setSessionId(id)
    setStatus('ready')
    setError(null)
  }, [])

  /**
   * Resolve which session the dev-studio entry should land on — without ever
   * spawning a container. Priority:
   *  1. Most recent in-progress iteration (`status='active'`) → resume it so
   *     the operator returns to their backgrounded work.
   *  2. Otherwise, for the tool-scoped entry, the tool's original adopted
   *     session (`status='adopted'`) → resume it READ-ONLY (its container is
   *     destroyed, so the ResumeOverlay surfaces a "继续开发" fork action). This
   *     replaces the old auto-fork-on-open, which spawned a container (~10-30s)
   *     and silently created an iteration the operator never asked for.
   *  3. Nothing to resume (generic entry, or a tool with no sessions) → hand
   *     off to the entry model-picker rather than auto-creating with the
   *     global-env model (which 404s when .env has no ANTHROPIC_*).
   *
   * All resume paths leave the session OUT of `ownedSessionIdRef`, so closing
   * the dialog never tears down or mutates a pre-existing session — including
   * the adopted baseline.
   */
  const resolveOrCreate = useCallback(
    async (signal: AbortSignal) => {
      setStatus('resolving')
      setError(null)
      // Status scope differs by entry:
      //  - Tool-scoped (toolId set): widen to `all` so we can land on the
      //    tool's adopted original when no active iteration exists.
      //  - Generic ("new tool", no toolId): stay `active`. Widening here would
      //    resurface an offline adopted/archived no-tool session — which the
      //    session-switcher (active-only) can't even show — instead of the
      //    fresh model-picker the operator expects from "new tool".
      const status = toolId ? 'all' : 'active'
      const params = new URLSearchParams({ toolId: toolId ?? 'none', status })
      try {
        const res = await fetch(`${SESSIONS_URL}?${params}`, { signal })
        if (res.ok) {
          const body = (await res.json()) as { sessions?: SessionRecord[] }
          const sessions = body.sessions ?? []
          // The list is ordered by lastActiveAt desc. Prefer the most recent
          // active iteration; for the tool-scoped entry only, fall back to the
          // adopted original (read-only landing on the published baseline).
          const recent = toolId
            ? (sessions.find((s) => s.status === 'active') ??
              sessions.find((s) => s.status === 'adopted'))
            : sessions.find((s) => s.status === 'active')
          if (recent) {
            resume(recent.id)
            return
          }
        }
        // Nothing to land on — let the operator pick a model and start fresh.
        setStatus('select-model')
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        // A flaky lookup must not block the operator — fall through to the
        // model-picker rather than surfacing an error screen.
        setStatus('select-model')
      }
    },
    [toolId, resume]
  )

  useEffect(() => {
    if (!enabled) return
    // Caller supplied an existing session id (NotificationCenter pivot,
    // bookmarked deep-link, etc.) — skip the resume lookup and use it as-is.
    // The id stays out of ownedSessionIdRef so the unmount cleanup leaves it alone.
    if (initialSessionId) {
      sessionIdRef.current = initialSessionId
      setSessionId(initialSessionId)
      setStatus('ready')
      setError(null)
      return
    }
    const ac = new AbortController()
    void resolveOrCreate(ac.signal)
    return () => ac.abort()
  }, [enabled, attempt, resolveOrCreate, initialSessionId])

  /**
   * Background (suspend) the session this hook created when the component
   * unmounts — e.g. the operator navigated to another page. This must NOT
   * delete the work: the BFF keeps the row `active` (so the dev-studio entry
   * button still offers "resume") and preserves the workspace; only the
   * container is torn down. An empty, never-touched session is purged
   * server-side instead, to avoid leaving an empty "resumable" session behind.
   *
   * Sessions the user *resumed* into (not created by this hook instance) are
   * left untouched — they are not tracked in `ownedSessionIdRef`. Explicit
   * discard/terminate goes through the close-confirm dialog's own DELETE, not
   * this path.
   */
  const suspendOwned = useCallback(async () => {
    const id = ownedSessionIdRef.current
    sessionIdRef.current = null
    ownedSessionIdRef.current = null
    setSessionId(null)
    setStatus('idle')
    if (!id) return
    // keepalive so the request still goes out during page unload.
    await fetch(`${SESSIONS_URL}/${encodeURIComponent(id)}/suspend`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => {})
  }, [])

  // Cleanup on unmount: also cover the case where the dialog closes
  useEffect(() => {
    return () => {
      void suspendOwned()
    }
  }, [suspendOwned])

  const retry = useCallback(() => setAttempt((a) => a + 1), [])

  /**
   * Create a fresh session pinned to the operator-chosen coding model. Driven
   * by the entry model-picker (status='select-model'). Uses its own
   * AbortController since it fires outside the mount effect.
   */
  const startWithModel = useCallback(
    (modelConfigId: string | null) => {
      void create(new AbortController().signal, modelConfigId)
    },
    [create]
  )

  const switchTo = useCallback((id: string) => {
    sessionIdRef.current = id
    setSessionId(id)
    setStatus('ready')
    setError(null)
  }, [])

  return { sessionId, status, error, retry, startWithModel, setSessionId: switchTo }
}
