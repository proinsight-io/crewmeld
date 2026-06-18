/**
 * [IDENTITY-FIELD-MAP · MERGE→dev0.0.1] Seed/fallback channel field map.
 *
 * Equivalent to the previously hardcoded raw→ChannelUserDetail mappings in
 * getFeishuUserDetail / getDingtalkUserDetail / getWecomUserDetail. When the DB
 * `channel_field_mappings` table is empty, this is used verbatim, so behavior is
 * unchanged until an admin overrides it. Channel column keys index the raw record
 * each fetcher produces: feishu = FeishuUserProfile keys; dingtalk = user.get
 * result keys (+ injected deptNames); wecom = user.get keys (+ deptNames).
 */

import type { ChannelFieldMapping, NormalizedFieldDef } from './field-map-types'

/** Core normalized fields = ChannelUserDetail strong keys. Fixed, not custom. */
const CORE_FIELDS: NormalizedFieldDef[] = [
  { key: 'name', label: '姓名', isCustom: false, target: 'scope', valueType: 'string' },
  { key: 'email', label: '邮箱', isCustom: false, target: 'scope', valueType: 'string' },
  { key: 'mobile', label: '手机', isCustom: false, target: 'scope', valueType: 'string' },
  { key: 'employeeNo', label: '工号', isCustom: false, target: 'scope', valueType: 'string' },
  { key: 'employeeType', label: '雇佣类型', isCustom: false, target: 'scope', valueType: 'string' },
  { key: 'deptNames', label: '部门名', isCustom: false, target: 'scope', valueType: 'string[]' },
  { key: 'positions', label: '岗位', isCustom: false, target: 'scope', valueType: 'string[]' },
  { key: 'orgUnitIds', label: '部门ID', isCustom: false, target: 'scope', valueType: 'string[]' },
  { key: 'orgUnitCustomIds', label: '部门自定义ID', isCustom: false, target: 'scope', valueType: 'string[]' },
  { key: 'leaderId', label: '直属上级ID', isCustom: false, target: 'scope', valueType: 'string' },
]

export const DEFAULT_CHANNEL_FIELD_MAP: ChannelFieldMapping = {
  fields: CORE_FIELDS,
  paths: {
    name: { feishu: { kind: 'path', path: 'name' }, dingtalk: { kind: 'path', path: 'name' }, wecom: { kind: 'path', path: 'name' } },
    email: { feishu: { kind: 'path', path: 'email' }, dingtalk: { kind: 'path', path: 'email' }, wecom: { kind: 'path', path: 'email' } },
    mobile: { feishu: { kind: 'path', path: 'mobile' }, dingtalk: { kind: 'path', path: 'mobile' }, wecom: { kind: 'path', path: 'mobile' } },
    employeeNo: { feishu: { kind: 'path', path: 'employeeNo' }, dingtalk: { kind: 'path', path: 'job_number' }, wecom: { kind: 'path', path: 'userid' } },
    employeeType: { feishu: { kind: 'path', path: 'employeeType' } },
    deptNames: { feishu: { kind: 'path', path: 'departmentNames' }, dingtalk: { kind: 'path', path: 'deptNames' }, wecom: { kind: 'path', path: 'deptNames' } },
    positions: { feishu: { kind: 'path', path: 'jobTitle' }, dingtalk: { kind: 'path', path: 'title' }, wecom: { kind: 'path', path: 'position' } },
    orgUnitIds: { feishu: { kind: 'path', path: 'departmentIds' }, dingtalk: { kind: 'path', path: 'dept_id_list' }, wecom: { kind: 'path', path: 'department' } },
    orgUnitCustomIds: { feishu: { kind: 'path', path: 'departmentCustomIds' } },
    leaderId: { feishu: { kind: 'path', path: 'leaderId' }, dingtalk: { kind: 'path', path: 'manager_userid' }, wecom: { kind: 'path', path: 'direct_leader.0' } },
  },
}
