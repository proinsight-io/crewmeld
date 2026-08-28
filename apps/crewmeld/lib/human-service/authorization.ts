/** Return whether a user is allowed to work on an employee's human handoffs. */
export function isSupportUserAllowed(config: unknown, userId: string): boolean {
  if (!config || typeof config !== 'object') return true
  const value = (config as Record<string, unknown>).allowedSupportUserIds
  if (!Array.isArray(value) || value.length === 0) return true
  return value.some((entry): entry is string => typeof entry === 'string' && entry === userId)
}

import { and, eq, sql } from 'drizzle-orm'
import { db, employeeApiKeys } from '@crewmeld/db'

export async function canSupportEmployee(employeeId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: employeeApiKeys.id }).from(employeeApiKeys).where(and(
    eq(employeeApiKeys.employeeId, employeeId),
    eq(employeeApiKeys.active, true),
    sql`${employeeApiKeys.userId} = ${userId} OR ${employeeApiKeys.allowedSupportUserIds} @> ${JSON.stringify([userId])}::jsonb`,
  )).limit(1)
  return Boolean(row)
}
