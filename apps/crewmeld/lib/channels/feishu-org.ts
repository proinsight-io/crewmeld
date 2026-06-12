/**
 * Feishu org-structure listing for the SOP permission pickers.
 * Reuses {@link getTenantAccessToken} from feishu-client.
 *
 * Docs: contact/v3/departments (children), contact/v3/users/find_by_department.
 */

import { createLogger } from '@crewmeld/logger'
import { getTenantAccessToken } from './feishu-client'
import type { DepartmentNode, DirectoryUserPage } from './org-directory-types'

const logger = createLogger('FeishuOrg')
const BASE = 'https://open.feishu.cn/open-apis'

interface FeishuDeptItem {
  department_id?: string
  open_department_id?: string
  name?: string
  parent_department_id?: string
  has_child?: boolean
}

/**
 * List direct child departments of `parentId` ('0' = tenant root).
 *
 * @remarks Department ids are returned as `open_department_id` (not the tenant-local
 * `department_id`). This intentionally matches the id space that
 * {@link getFeishuUserProfile} resolves into `scope.orgUnitIds` at identity time — it
 * fetches the user profile with `department_id_type=open_department_id`. Keeping the
 * picker and the runtime identity in the same id space is what lets a Feishu 部门
 * permission rule actually match at eval time. The tenant root id '0' is valid for both
 * id types, so it stays the default `parentId`.
 * @remarks Returns at most 50 direct children (page_size=50, no pagination loop on
 * the V1 dept-children endpoint). A parent with more than 50 direct child departments
 * will be silently truncated.
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listFeishuDepartments(
  appId: string,
  appSecret: string,
  parentId = '0'
): Promise<DepartmentNode[]> {
  const token = await getTenantAccessToken(appId, appSecret)
  const url = `${BASE}/contact/v3/departments/${encodeURIComponent(parentId)}/children?department_id_type=open_department_id&page_size=50`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = (await res.json()) as { code: number; msg: string; data?: { items?: FeishuDeptItem[] } }
  if (data.code !== 0) {
    logger.warn('feishu list departments failed', { msg: data.msg, parentId })
    return []
  }
  return (data.data?.items ?? []).map((d) => ({
    // Use the open id so stored rule ids align with identity's orgUnitIds.
    id: d.open_department_id ?? d.department_id ?? '',
    name: d.name ?? '',
    parentId: d.parent_department_id,
    hasChildren: d.has_child,
  }))
}

interface FeishuUserItem {
  user_id?: string
  open_id?: string
  name?: string
}

/**
 * List members of a department, one page at a time.
 *
 * @remarks `deptId` is an `open_department_id` (the picker stores open ids — see
 * {@link listFeishuDepartments}), so the `find_by_department` filter is issued with
 * `department_id_type=open_department_id` to resolve in the same id space. `user_id_type`
 * stays `user_id`, matching the person id space that {@link getFeishuUserProfile} resolves
 * into `identity.employeeId`.
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listFeishuDepartmentUsers(
  appId: string,
  appSecret: string,
  deptId: string,
  cursor?: string
): Promise<DirectoryUserPage> {
  const token = await getTenantAccessToken(appId, appSecret)
  const params = new URLSearchParams({
    department_id: deptId,
    department_id_type: 'open_department_id',
    user_id_type: 'user_id',
    page_size: '50',
  })
  if (cursor) params.set('page_token', cursor)
  const url = `${BASE}/contact/v3/users/find_by_department?${params.toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = (await res.json()) as {
    code: number
    msg: string
    data?: { items?: FeishuUserItem[]; has_more?: boolean; page_token?: string }
  }
  if (data.code !== 0) {
    logger.warn('feishu list dept users failed', { msg: data.msg, deptId })
    return { users: [] }
  }
  return {
    users: (data.data?.items ?? []).map((u) => ({ userId: u.user_id ?? u.open_id ?? '', name: u.name ?? '' })),
    nextCursor: data.data?.has_more ? data.data?.page_token : undefined,
  }
}
