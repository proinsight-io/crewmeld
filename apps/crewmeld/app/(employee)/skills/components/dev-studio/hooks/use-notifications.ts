'use client'

import useSWR from 'swr'

const NOTIFICATIONS_URL = '/api/employee/dev-studio/notifications'

/**
 * Dependency-approval notification: one session with libraries / domains
 * declared in its manifest that the operator has not yet approved.
 */
export interface DependencyNotification {
  sessionId: string
  sessionTitle: string
  pendingLibraries: string[]
  pendingDomains: string[]
  streaming: boolean
}

/**
 * Pending ask notification: one row from `tool_dev_pending_actions` whose
 * status is `pending`.
 */
export interface AskNotification {
  sessionId: string
  sessionTitle: string
  askId: string
  type: string
  payload: unknown
  streaming: boolean
}

interface NotificationsPayload {
  dependencies: DependencyNotification[]
  asks: AskNotification[]
}

async function notificationsFetcher(url: string): Promise<NotificationsPayload> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Notifications request failed (${res.status})`)
  }
  return (await res.json()) as NotificationsPayload
}

/**
 * Return type for {@link useNotifications}.
 */
export interface UseNotificationsResult {
  /** Dependency approval requests across all the caller's active sessions. */
  dependencies: DependencyNotification[]
  /** Pending ask actions across all the caller's active sessions. */
  asks: AskNotification[]
  /** Set of session ids that have at least one pending dependency or ask. */
  pendingSessionIds: Set<string>
}

/**
 * SWR-backed notifications aggregate for the dev-studio header.
 *
 * Polls `/api/employee/dev-studio/notifications` every 30s so the per-session
 * pending-action badge in `SessionSwitcher` stays fresh without a manual
 * reload. The derived `pendingSessionIds` set is the cheapest membership
 * check the dropdown can do per row.
 */
export function useNotifications(): UseNotificationsResult {
  const { data } = useSWR<NotificationsPayload>(NOTIFICATIONS_URL, notificationsFetcher, {
    refreshInterval: 30_000,
  })
  const dependencies = data?.dependencies ?? []
  const asks = data?.asks ?? []
  const pendingSessionIds = new Set<string>([
    ...dependencies.map((d) => d.sessionId),
    ...asks.map((a) => a.sessionId),
  ])
  return { dependencies, asks, pendingSessionIds }
}
