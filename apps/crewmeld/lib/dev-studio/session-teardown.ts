/**
 * Shared session teardown.
 *
 * Physically removes a dev-studio session and all of its related records,
 * tearing down any live container. Extracted so the explicit DELETE endpoint
 * and the suspend endpoint's empty-session cleanup branch perform identical
 * teardown instead of drifting two near-copies.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { db, toolDevMessages, toolDevPendingActions, toolDevSessions } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { getDevStudioEnv } from './env'
import { OpenSandboxClient } from './opensandbox-client'
import { paths } from './paths'
import type { SessionRecord } from './session-store'

const log = createLogger('dev-studio:session-teardown')

/**
 * Permanently remove a session: destroy its container (best-effort), delete
 * its messages + pending actions + the session row, and — only when the
 * session is NOT linked to a tool — remove the host workspace directory.
 *
 * Adopted / iteration sessions (`toolId` set) keep their workspace because it
 * belongs to the tool and may back future iterations.
 *
 * @param session - The fully-loaded session row to tear down.
 */
export async function purgeSession(session: SessionRecord): Promise<void> {
  // Best-effort container destroy; the OpenSandbox TTL is the backstop.
  if (session.activeContainerId) {
    try {
      const env = getDevStudioEnv()
      const client = new OpenSandboxClient({
        serverUrl: env.OPENSANDBOX_SERVER_URL,
        apiKey: env.OPENSANDBOX_API_KEY,
      })
      await client.destroy(session.activeContainerId)
    } catch {
      // Swallow — TTL reaps the container if this fails.
    }
  }

  // Physical delete: child records first (messages, pending actions), then the
  // session row itself.
  await db.delete(toolDevMessages).where(eq(toolDevMessages.sessionId, session.id))
  await db.delete(toolDevPendingActions).where(eq(toolDevPendingActions.sessionId, session.id))
  await db.delete(toolDevSessions).where(eq(toolDevSessions.id, session.id))

  // Workspace cleanup: only delete host dirs when no tool is linked. Derive the
  // session root from the `paths` facade so it matches the configured NFS
  // layout regardless of the (debug-only) `session.workspaceDir` column.
  if (!session.toolId) {
    const workspaceBff = paths.sessionWorkspace.forBff(session.id)
    const sessionRoot = path.dirname(workspaceBff)
    try {
      await rm(sessionRoot, { recursive: true, force: true })
    } catch (e) {
      // Non-fatal; the DB records are already gone.
      log.warn(
        { err: e, sessionRoot, sessionId: session.id },
        'failed to delete workspace directory'
      )
    }
  }
}
