/**
 * Authorization helper for /api/employee/tool-execution/[execId]/* routes.
 *
 * Verifies the requesting `userId` owns the execution identified by `execId`.
 * Ownership is resolved through the `tool_executions` table:
 *
 *   1. Row not found     → unauthorized (false)
 *   2. exec.userId match → owner (true)
 *   3. exec.sessionId    → cross-check `tool_dev_sessions.userId`
 *   4. exec.instanceId   → cross-check `tool_instances.createdBy`
 *
 * The session/instance fallbacks cover legacy rows where `exec.userId` was
 * not populated, and provide defense-in-depth if the dev-studio session or
 * instance is transferred to another user post-invocation.
 *
 * Refs spec 2026-05-28-cross-platform-nfs-volume-design.md §9.5.
 */
import { db, toolDevSessions, toolExecutions, toolInstances } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'

export async function authorizeExecution(execId: string, userId: string): Promise<boolean> {
  const [exec] = await db
    .select({
      userId: toolExecutions.userId,
      sessionId: toolExecutions.sessionId,
      instanceId: toolExecutions.instanceId,
    })
    .from(toolExecutions)
    .where(eq(toolExecutions.id, execId))
    .limit(1)

  if (!exec) return false
  if (exec.userId === userId) return true

  if (exec.sessionId) {
    const [session] = await db
      .select({ id: toolDevSessions.id })
      .from(toolDevSessions)
      .where(and(eq(toolDevSessions.id, exec.sessionId), eq(toolDevSessions.userId, userId)))
      .limit(1)
    if (session) return true
  }

  if (exec.instanceId) {
    const [instance] = await db
      .select({ id: toolInstances.id })
      .from(toolInstances)
      .where(and(eq(toolInstances.id, exec.instanceId), eq(toolInstances.createdBy, userId)))
      .limit(1)
    if (instance) return true
  }

  return false
}
