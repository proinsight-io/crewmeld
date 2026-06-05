/**
 * GET /api/employee/dev-studio/notifications
 *
 * Sub-spec B Phase 8: single endpoint backing the global NotificationCenter
 * widget. Aggregates two kinds of pending HITL signals across all the
 * caller's active sessions:
 *
 *  - `dependencies`: one entry per session that has libraries / domains in
 *    its manifest that haven't been approved yet. Computed as
 *    `manifest.dependencies.* MINUS session.approvedDependencies.*`.
 *  - `asks`: one entry per row in `tool_dev_pending_actions` whose
 *    `status === 'pending'`, restricted to the caller's session ids so
 *    cross-user data cannot leak.
 *
 * Each entry includes a `streaming` boolean sourced from the in-process
 * `sessionStore.hasActiveStreaming` flag so the UI can dim the action when
 * the AI is still talking.
 *
 * Cross-user safety: `sessionStore.list(userId)` is the gate — we never
 * query the pending-actions table without first scoping to the caller's own
 * session ids. When the user owns zero sessions, the asks query is skipped
 * entirely (an empty `inArray(...)` is invalid in drizzle anyway).
 *
 * Error semantics: 401 unauth only. Empty result sets are normal and return 200.
 */
import { db, toolDevPendingActions } from '@crewmeld/db'
import { and, eq, inArray } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { normalizeName } from '@/lib/dev-studio/dependency-spec'
import { readManifestFromSession } from '@/lib/dev-studio/manifest-reader'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { messages } from '@/locales'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { getSandboxSettings } from '@/lib/sandbox/settings'

interface DependencyNotification {
  sessionId: string
  sessionTitle: string
  pendingLibraries: string[]
  pendingDomains: string[]
  streaming: boolean
}

interface AskNotification {
  sessionId: string
  sessionTitle: string
  askId: string
  type: string
  payload: unknown
  streaming: boolean
}

/**
 * Compute the set difference `manifestList - approvedList`, preserving the
 * order from the manifest. Used to surface the libraries / domains the AI
 * declared but the operator has not yet approved.
 */
function difference(manifestList: string[], approvedList: string[]): string[] {
  const approved = new Set(approvedList)
  return manifestList.filter((entry) => !approved.has(entry))
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getCurrentUserRole()
  // Fallback title for sessions the AI has not yet auto-titled. Picked per
  // request locale so the dropdown / center card reads natively for the
  // operator instead of forcing a Chinese string into an English UI.
  // server-t's MessageKey type only covers `api.*` keys, so we index the
  // messages object directly for this UI-namespace key.
  const locale = resolveLocale(req)
  const DEFAULT_TITLE = messages[locale].devStudio.header.untitled
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sessions = await sessionStore.list(auth.userId, { status: 'active' })

  // Globally preset packages are admin-blessed — a library covered by one (by
  // normalized name) never needs per-tool approval, so it is excluded from the
  // pending set (and thus does not gate adopt). See Sub-spec C (Model A′).
  const settings = await getSandboxSettings()
  const presetNames = new Set(settings.presetPythonPackages.map(normalizeName))

  // Dependency approvals: one entry per session with un-approved manifest deps.
  const depEntries = await Promise.all(
    sessions.map(async (s): Promise<DependencyNotification | null> => {
      const manifest = await readManifestFromSession(s.id).catch(() => null)
      if (!manifest) return null
      const pendingLibraries = difference(
        manifest.dependencies.libraries,
        s.approvedDependencies.libraries
      ).filter((lib) => !presetNames.has(normalizeName(lib)))
      const pendingDomains = difference(
        manifest.dependencies.domains,
        s.approvedDependencies.domains
      )
      if (pendingLibraries.length === 0 && pendingDomains.length === 0) return null
      return {
        sessionId: s.id,
        sessionTitle: s.title ?? DEFAULT_TITLE,
        pendingLibraries,
        pendingDomains,
        streaming: sessionStore.hasActiveStreaming(s.id),
      }
    })
  )
  const dependencies = depEntries.filter(
    (entry): entry is DependencyNotification => entry !== null
  )

  // Pending asks: restricted to the caller's session ids.
  const sessionIds = sessions.map((s) => s.id)
  let asks: AskNotification[] = []
  if (sessionIds.length > 0) {
    const titleById = new Map(sessions.map((s) => [s.id, s.title ?? DEFAULT_TITLE]))
    const rows = await db
      .select({
        sessionId: toolDevPendingActions.sessionId,
        askId: toolDevPendingActions.askId,
        type: toolDevPendingActions.type,
        payload: toolDevPendingActions.payload,
      })
      .from(toolDevPendingActions)
      .where(
        and(
          inArray(toolDevPendingActions.sessionId, sessionIds),
          eq(toolDevPendingActions.status, 'pending')
        )
      )
    asks = rows.map((r) => ({
      sessionId: r.sessionId,
      // Map.get returns undefined when the id is unexpected — defensive fallback.
      sessionTitle: titleById.get(r.sessionId) ?? DEFAULT_TITLE,
      askId: r.askId,
      type: r.type,
      payload: r.payload,
      streaming: sessionStore.hasActiveStreaming(r.sessionId),
    }))
  }

  return Response.json({ dependencies, asks })
}
