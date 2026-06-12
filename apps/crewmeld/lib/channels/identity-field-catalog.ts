/**
 * Per-channel-type catalog of matchable identity fields for SOP permission.
 * Drives the field dropdown + value-input control in the permission UI. Keys
 * here MUST match the field keys understood by the visibility matcher's
 * getFieldValue().
 *
 * Supported keys (from visibility-matcher.ts getFieldValue):
 *   employeeId, orgUnitIds, positions, employeeNo, leaderId,
 *   name, email, mobile, deptNames, employeeType
 */

import type { IdentityFieldDef } from '@/lib/sop/visibility-types'

const COMMON: IdentityFieldDef[] = [
  { key: 'orgUnitIds', label: '部门', valueSource: 'dept-picker' },
  { key: 'employeeId', label: '用户', valueSource: 'user-picker' },
  { key: 'leaderId', label: '直属上级', valueSource: 'user-picker' },
  { key: 'employeeNo', label: '工号', valueSource: 'free-text' },
  { key: 'positions', label: '职务/岗位', valueSource: 'free-text' },
  { key: 'name', label: '姓名', valueSource: 'free-text' },
  { key: 'email', label: '邮箱', valueSource: 'free-text' },
  { key: 'mobile', label: '手机', valueSource: 'free-text' },
]

/** Channel-type → matchable fields. Keyed by ChannelPlugin.id / connection type. */
const CATALOG: Record<string, IdentityFieldDef[]> = {
  feishu: [...COMMON, { key: 'employeeType', label: '员工类型', valueSource: 'free-text' }],
  dingtalk: COMMON,
  wecom: COMMON,
  // Web callers have no IM org identity — only platform user id + RBAC role.
  web: [
    { key: 'employeeId', label: '用户', valueSource: 'web-user-picker' },
    { key: 'roles', label: '角色', valueSource: 'web-role-picker' },
  ],
}

/** Returns the matchable-field catalog for a channel type, or [] if unsupported. */
export function getIdentityFieldCatalog(channelType: string): IdentityFieldDef[] {
  return CATALOG[channelType] ?? []
}
