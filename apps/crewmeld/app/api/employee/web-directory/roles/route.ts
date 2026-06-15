import type { PlatformRole } from '@crewmeld/db/schema'
import { platformRoleEnum } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

export const dynamic = 'force-dynamic'

const logger = createLogger('API:WebDirectory:Roles')

/**
 * Chinese display labels for platform RBAC roles. The role `id` is the role NAME
 * itself (the same id-space stored by the SOP web-role-picker and populated into
 * `ScopeIdentity.roles` by resolveWebIdentity), so the matcher compares like for
 * like.
 */
const ROLE_LABELS: Record<PlatformRole, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  member: '普通成员',
}

/** List all platform RBAC roles for the SOP web-permission role picker. */
export async function GET() {
  try {
    const auth = await requirePermission('sop:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const roles = platformRoleEnum.enumValues.map((role) => ({
      id: role,
      name: ROLE_LABELS[role],
    }))

    return apiOk({ roles })
  } catch (error) {
    logger.error('Failed to list web-directory roles', error)
    return apiErr('api.role.fetchListFailed', { status: 500 })
  }
}
