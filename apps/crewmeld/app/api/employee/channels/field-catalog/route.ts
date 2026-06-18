import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import '@/lib/channels/plugins' // side-effect: register plugins
import { getAllPlugins } from '@/lib/channels/plugin-registry'

/**
 * GET /api/employee/channels/field-catalog — Channel raw-field catalog for the identity field-map editor dropdowns.
 *
 * @remarks The returned list is editor-oriented: it includes a SYNTHETIC `web`
 * column that is NOT a registered channel plugin (web has no directory). Other
 * callers must not assume every entry maps to a plugin.
 */
export async function GET(): Promise<Response> {
  const auth = await requirePermission('channel:list')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }
  try {
    const channels = getAllPlugins()
      .filter((p) => p.identityRawFields && p.identityRawFields.length > 0)
      .map((p) => ({ id: p.id, label: p.label, fields: p.identityRawFields ?? [] }))
    // 'web' is not an IM channel plugin (no directory). It is surfaced here so the
    // field-map editor exposes a web column whose CONST cells can simulate an org
    // identity for platform/web callers (resolveWebIdentity seeds name/userId/email/role).
    channels.push({
      id: 'web',
      label: 'Web（平台/模拟）',
      fields: [
        { path: 'name', label: '用户名' },
        { path: 'userId', label: '用户ID' },
        { path: 'email', label: '邮箱' },
        { path: 'role', label: '平台角色' },
      ],
    })
    return apiOk({ channels })
  } catch {
    return apiErr('api.channelFieldMap.catalogFailed', { status: 500 })
  }
}
