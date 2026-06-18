/**
 * Web (platform-console) → ScopeIdentity resolver.
 *
 * Web callers reach a digital employee through the platform chat console, not an
 * IM channel. They therefore carry NO IM org identity — no department, no
 * employee number, no position. The only identity a web caller has is
 * their platform user id (better-auth `user.id`) and their platform RBAC role.
 *
 * This resolver loads the platform user and their RBAC role(s) and maps them onto
 * {@link ScopeIdentity} so SOP visibility rules can gate web access by platform
 * user (matched on `employeeId`) and by RBAC role (matched on `roles`).
 *
 * The platform user `{ name, userId, email, role }` is used as the raw "seed" and
 * run through the channel field map's `web` column. CONST cells in that column let
 * an admin SIMULATE an org identity for web/platform callers (e.g. inject an
 * employee number or position), enriching `raw` + org fields (positions/employeeNo/leaderId/orgUnitIds)
 * while the platform RBAC role(s) are preserved unchanged.
 *
 * @remarks Roles live in the same id-space as the SOP web-role-picker: both use
 * the {@link PlatformRole} NAME (`'super_admin' | 'admin' | 'member'`), not a
 * surrogate id. A user has exactly one role (1-to-1 via `employee_platform_roles`),
 * but `roles` is an array for matcher compatibility. When no role record exists we
 * fall back to `user.isSuperUser` (mirrors `getCurrentUserRole`).
 *
 * @remarks Field-map enrichment is best-effort/non-blocking: a field-map load or
 * normalize failure degrades to the base RBAC identity (empty org fields, `raw={}`)
 * rather than failing the conversation turn.
 */

import { createLogger } from '@crewmeld/logger'
import { db } from '@crewmeld/db'
import type { PlatformRole } from '@crewmeld/db/schema'
import { employeePlatformRoles, user as userTable } from '@crewmeld/db/schema'
import { eq } from 'drizzle-orm'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'
import { loadActiveFieldMap } from './field-map-store'
import { normalizeIdentityFromRaw } from './normalize'
import type { ScopeIdentity } from './types'

const logger = createLogger('WebIdentity')

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
    .select({ name: userTable.name, email: userTable.email, isSuperUser: userTable.isSuperUser })
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

  // Seed = platform user fields; normalize against the 'web' field-map column so an
  // admin's CONST cells can simulate org identity into raw + scope fields. With no
  // web cells configured, `detail` is empty and the result matches the prior shape
  // (positions=[], employeeNo=undefined, scope.orgUnitIds=[]) except raw becomes {}.
  const seed: Record<string, unknown> = {
    name: userRecord.name,
    userId,
    email: userRecord.email,
    role,
  }
  // Field-map enrichment is best-effort: a transient field-map load or normalize
  // failure must not abort the conversation turn (mirrors the IM path). On failure
  // `detail` stays empty, yielding the base RBAC identity (positions=[],
  // employeeNo=undefined, scope.orgUnitIds=[], raw={}).
  let detail: ChannelUserDetail = {}
  try {
    detail = normalizeIdentityFromRaw(seed, await loadActiveFieldMap(), 'web')
  } catch (err) {
    logger.warn('web field-map enrichment failed; using base identity', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    employeeId: userId,
    positions: detail.positions ?? [],
    employeeNo: detail.employeeNo,
    leaderId: detail.leaderId,
    scope: { orgUnitIds: detail.orgUnitIds ?? [] },
    roles: [role],
    raw: detail,
    profile: {
      channel: 'web',
      externalUserId: userId,
      senderName: userRecord.name,
    },
  }
}
