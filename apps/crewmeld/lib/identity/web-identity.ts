/**
 * Web (platform-console) → ScopeIdentity resolver.
 *
 * Web callers reach a digital employee through the platform chat console, not an
 * IM channel. They therefore carry NO IM org identity — no department, no 工号
 * (employee number), no 职务 (position). The only identity a web caller has is
 * their platform user id (better-auth `user.id`) and their platform RBAC role.
 *
 * This resolver loads the platform user and their RBAC role(s) and maps them onto
 * {@link ScopeIdentity} so SOP visibility rules can gate web access by platform
 * user (matched on `employeeId`) and by RBAC role (matched on `roles`).
 *
 * @remarks Roles live in the same id-space as the SOP web-role-picker: both use
 * the {@link PlatformRole} NAME (`'super_admin' | 'admin' | 'member'`), not a
 * surrogate id. A user has exactly one role (1-to-1 via `employee_platform_roles`),
 * but `roles` is an array for matcher compatibility. When no role record exists we
 * fall back to `user.isSuperUser` (mirrors `getCurrentUserRole`).
 */

import { db } from '@crewmeld/db'
import type { PlatformRole } from '@crewmeld/db/schema'
import { employeePlatformRoles, user as userTable } from '@crewmeld/db/schema'
import { eq } from 'drizzle-orm'
import type { ScopeIdentity } from './types'

/**
 * Resolve a web caller's {@link ScopeIdentity} from their platform user id.
 *
 * @param userId - Platform user id (better-auth `user.id`); for web conversations
 *   this equals the conversation `userId`.
 * @returns The mapped identity, or `null` when the user does not exist
 *   (callers fail-closed).
 */
export async function resolveWebIdentity(userId: string): Promise<ScopeIdentity | null> {
  const [userRecord] = await db
    .select({ name: userTable.name, isSuperUser: userTable.isSuperUser })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1)

  if (!userRecord) return null

  const [roleRecord] = await db
    .select({ role: employeePlatformRoles.role, isDisabled: employeePlatformRoles.isDisabled })
    .from(employeePlatformRoles)
    .where(eq(employeePlatformRoles.userId, userId))
    .limit(1)

  // Fail-closed: a disabled role record must not grant SOP access.
  if (roleRecord?.isDisabled === true) return null

  const role: PlatformRole = roleRecord?.role ?? (userRecord.isSuperUser ? 'super_admin' : 'member')

  return {
    employeeId: userId,
    positions: [],
    scope: { orgUnitIds: [] },
    roles: [role],
    profile: {
      channel: 'web',
      externalUserId: userId,
      senderName: userRecord.name,
    },
  }
}
