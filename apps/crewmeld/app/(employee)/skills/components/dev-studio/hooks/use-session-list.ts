'use client'

import useSWR, { type KeyedMutator } from 'swr'
import type { SessionRecord } from '@/lib/dev-studio/session-store'

const SESSIONS_URL = '/api/employee/dev-studio/sessions'

interface SessionListPayload {
  sessions: SessionRecord[]
}

/**
 * Options for {@link useSessionList}.
 */
export interface UseSessionListOptions {
  /**
   * Filter sessions linked to a specific tool. When set, the API receives
   * `?toolId=<value>`; when omitted the API receives `?toolId=none` so only
   * sessions with no tool association are returned.
   */
  toolId?: string
}

/**
 * SWR fetcher local to dev-studio hooks. Throws on non-2xx so SWR's `error`
 * state captures BFF failures (vs swallowing them as empty data).
 */
async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`)
  }
  return (await res.json()) as T
}

/**
 * Build the full URL for the sessions list endpoint, embedding query params
 * for `toolId` and `status` filtering.
 *
 * Status scope depends on context:
 *  - **Tool-scoped** (`toolId` set): `status=all` so the operator can review the
 *    tool's full history (active + adopted + archived) and fork a new iteration.
 *  - **Generic** (no `toolId`): `status=active` — only resumable sessions. Adopted
 *    sessions live under their tool, and archived rows are discarded; listing
 *    either here would offer a "resume" the rehydrate endpoint rejects with 410.
 */
function buildSessionsUrl(opts?: UseSessionListOptions): string {
  const params = new URLSearchParams()
  if (opts?.toolId) {
    params.set('toolId', opts.toolId)
    params.set('status', 'all')
  } else {
    params.set('toolId', 'none')
    params.set('status', 'active')
  }
  return `${SESSIONS_URL}?${params}`
}

/**
 * Return type for {@link useSessionList}.
 */
export interface UseSessionListResult {
  /** Current list of sessions (empty array while loading). */
  sessions: SessionRecord[]
  /** True until SWR has produced the first response. */
  isLoading: boolean
  /** SWR mutator — call to force a revalidation. */
  mutate: KeyedMutator<SessionListPayload>
  /** Create a new session, then revalidate the list. Returns the new row. */
  create: () => Promise<SessionRecord>
  /** Archive (soft-delete) a session by id, then revalidate. */
  archive: (id: string) => Promise<void>
  /** Mark a session as adopted (promoted into a real tool), then revalidate. */
  adopt: (id: string) => Promise<void>
  /** Physically delete a session by id, then revalidate. */
  remove: (id: string) => Promise<void>
}

/**
 * SWR-backed session list with CRUD shortcuts.
 *
 * Auto-refreshes every 60s so background-streamed phase/title updates from
 * other tabs show up without a manual reload. CRUD helpers call `mutate()`
 * after the mutation so the dropdown reflects the change immediately.
 *
 * @param opts.toolId - Filter by tool association. Omit to list generic
 *   (no-tool) sessions, which are scoped to `status=active` (resumable only);
 *   pass a tool id to list that tool's full history (`status=all`).
 */
export function useSessionList(opts?: UseSessionListOptions): UseSessionListResult {
  const swrKey = buildSessionsUrl(opts)
  const { data, mutate, isLoading } = useSWR<SessionListPayload>(swrKey, jsonFetcher, {
    refreshInterval: 60_000,
  })

  async function create(): Promise<SessionRecord> {
    const res = await fetch(SESSIONS_URL, { method: 'POST' })
    if (!res.ok) {
      throw new Error(`Failed to create session (${res.status})`)
    }
    const json = (await res.json()) as SessionRecord
    await mutate()
    return json
  }

  async function archive(id: string): Promise<void> {
    const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      throw new Error(`Failed to archive session (${res.status})`)
    }
    await mutate()
  }

  async function adopt(id: string): Promise<void> {
    const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(id)}/adopt`, { method: 'PATCH' })
    if (!res.ok) {
      throw new Error(`Failed to adopt session (${res.status})`)
    }
    await mutate()
  }

  async function remove(id: string): Promise<void> {
    const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      throw new Error(`Failed to delete session (${res.status})`)
    }
    await mutate()
  }

  return {
    sessions: data?.sessions ?? [],
    isLoading: !data && isLoading,
    mutate,
    create,
    archive,
    adopt,
    remove,
  }
}
