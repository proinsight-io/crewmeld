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
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { normalizeName } from '@/lib/dev-studio/dependency-spec'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { readManifestFromSession } from '@/lib/dev-studio/manifest-reader'
import { listOpencodeQuestions } from '@/lib/dev-studio/opencode-rest'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { messages } from '@/locales'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { getSandboxSettings } from '@/lib/sandbox/settings'

interface DependencyNotification {
  sessionId: string
  sessionTitle: string
  pendingLibraries: string[]
  pendingDomains: string[]
  pendingIps: string[]
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

/**
 * Pull a human-readable summary out of an opencode pending-question request's
 * first question, for the notify-only corner card. Falls back through
 * `question` → `header` → a generic label so the card never renders blank.
 */
function summarizeOpencodeQuestion(questions: unknown[], fallback: string): string {
  const first = questions[0] as { question?: string; header?: string } | undefined
  return first?.question ?? first?.header ?? fallback
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
      const pendingIps = difference(
        manifest.dependencies.ips,
        s.approvedDependencies.ips ?? []
      )
      if (pendingLibraries.length === 0 && pendingDomains.length === 0 && pendingIps.length === 0) return null
      return {
        sessionId: s.id,
        sessionTitle: s.title ?? DEFAULT_TITLE,
        pendingLibraries,
        pendingDomains,
        pendingIps,
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

  // Pending opencode questions: these live in the opencode server (not the
  // pending-actions table), so a backgrounded opencode session would otherwise
  // never surface a corner card. Fetch them per opencode session and append as
  // notify-only asks routing into the workbench, mirroring the claude flow.
  const opencodeSessions = sessions.filter(
    (s) => s.coderType === 'opencode' && s.activeContainerId && s.opencodeSessionId
  )
  if (opencodeSessions.length > 0) {
    const env = getDevStudioEnv()
    const provider = getCoderProvider('opencode')
    const client = new OpenSandboxClient({
      serverUrl: env.OPENSANDBOX_SERVER_URL,
      apiKey: env.OPENSANDBOX_API_KEY,
      useProxy: env.OPENSANDBOX_USE_PROXY,
    })
    const questionEntries = await Promise.all(
      opencodeSessions.map(async (s): Promise<AskNotification[]> => {
        try {
          // activeContainerId narrowed by the filter above.
          const baseUrl = await client.getEndpoint(s.activeContainerId as string, provider.port)
          const headers: Record<string, string> = {
            ...(provider.authHeader(env) ?? {}),
            ...client.proxyHeaders(),
          }
          const all = await listOpencodeQuestions(baseUrl, headers)
          return all
            .filter((q) => q.sessionID === s.opencodeSessionId)
            .map((q) => ({
              sessionId: s.id,
              sessionTitle: s.title ?? DEFAULT_TITLE,
              askId: q.id,
              type: 'opencode-question',
              payload: { question: summarizeOpencodeQuestion(q.questions, DEFAULT_TITLE) },
              streaming: sessionStore.hasActiveStreaming(s.id),
            }))
        } catch {
          // An unreachable sandbox / transient opencode error must not break the
          // whole notifications payload — treat it as "no pending questions".
          return []
        }
      })
    )
    asks = asks.concat(questionEntries.flat())
  }

  return Response.json({ dependencies, asks })
}
