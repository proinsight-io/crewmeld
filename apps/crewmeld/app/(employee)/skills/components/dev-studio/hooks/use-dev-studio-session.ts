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

export type SessionStatus = 'idle' | 'creating' | 'ready' | 'error'

export interface UseDevStudioSessionResult {
  sessionId: string | null
  status: SessionStatus
  error: ApiError | null
  retry: () => void
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

  const create = useCallback(async (signal: AbortSignal) => {
    setStatus('creating')
    setError(null)
    try {
      const res = await fetch(SESSIONS_URL, {
        method: 'POST',
        signal,
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
   * Fork the tool's most recent adopted session into a fresh iteration session.
   * Used by the tool-scoped entry ("develop existing tool") when no active
   * iteration exists yet, so the operator lands on the tool's code instead of a
   * blank session. The fork BFF copies the adopted workspace into the new
   * session's own dirs.
   *
   * The fork route resolves the source session by `toolId` from the body, so
   * the path segment is just a placeholder. Returns the new session id, or
   * `null` when there is nothing to fork (e.g. the tool has no adopted session).
   */
  const forkTool = useCallback(async (tid: string, signal: AbortSignal): Promise<string | null> => {
    const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(tid)}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolId: tid }),
      signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { sessionId?: string }
    return body.sessionId ?? null
  }, [])

  /**
   * Resume the most recent active session if one exists; otherwise:
   *  - tool-scoped entry (toolId set): fork the adopted tool so the operator
   *    lands on its code rather than a blank session;
   *  - generic entry: create a fresh new-tool session.
   *
   * This is the entry behavior: clicking the dev-studio button returns the
   * operator to their backgrounded work instead of spawning a new sandbox and
   * suspending the old one. To deliberately start fresh while a session is
   * running, the in-dialog SessionSwitcher's "+ new session" issues its own
   * create (which the BFF backgrounds the old container for).
   */
  const resolveOrCreate = useCallback(
    async (signal: AbortSignal) => {
      setStatus('creating')
      setError(null)
      const params = new URLSearchParams({ toolId: toolId ?? 'none', status: 'active' })
      try {
        const res = await fetch(`${SESSIONS_URL}?${params}`, { signal })
        if (res.ok) {
          const body = (await res.json()) as { sessions?: SessionRecord[] }
          // The list endpoint orders by lastActiveAt desc, so [0] is the most
          // recently active session — the one the operator most likely wants.
          const recent = body.sessions?.[0]
          if (recent) {
            resume(recent.id)
            return
          }
        }
        // Nothing to resume. For the tool-scoped entry, fork the adopted tool so
        // the operator continues from its code; the fork is owned by this hook
        // so it suspends (not deletes) on unmount. Only when there is nothing to
        // fork do we fall through to a fresh blank session.
        if (toolId) {
          const forkedId = await forkTool(toolId, signal)
          if (forkedId) {
            sessionIdRef.current = forkedId
            ownedSessionIdRef.current = forkedId
            setSessionId(forkedId)
            setStatus('ready')
            setError(null)
            return
          }
        }
        // Non-ok response, empty list, or nothing to fork: create fresh.
        await create(signal)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        // A flaky lookup/fork must not block the operator from working — fall
        // back to creating a new session rather than surfacing an error screen.
        await create(signal)
      }
    },
    [toolId, create, resume, forkTool]
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

  const switchTo = useCallback((id: string) => {
    sessionIdRef.current = id
    setSessionId(id)
    setStatus('ready')
    setError(null)
  }, [])

  return { sessionId, status, error, retry, setSessionId: switchTo }
}
