/**
 * DingTalk org-structure listing for SOP permission pickers.
 * Reuses {@link getAccessToken} from dingtalk-client.
 * Docs: topapi/v2/department/listsub, topapi/v2/user/list.
 */

import { createLogger } from '@crewmeld/logger'
import { getAccessToken } from './dingtalk-client'
import type { DepartmentNode, DirectoryUserPage } from './org-directory-types'

const logger = createLogger('DingtalkOrg')
const BASE = 'https://oapi.dingtalk.com'

interface DingDept { dept_id?: number; name?: string; parent_id?: number }

/**
 * List direct child departments of `parentId` ('1' = root).
 *
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listDingtalkDepartments(
  appKey: string,
  appSecret: string,
  parentId = '1'
): Promise<DepartmentNode[]> {
  const token = await getAccessToken(appKey, appSecret)
  const res = await fetch(`${BASE}/topapi/v2/department/listsub?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: Number(parentId) }),
  })
  const data = (await res.json()) as { errcode: number; errmsg?: string; result?: DingDept[] }
  if (data.errcode !== 0) {
    logger.warn('dingtalk list departments failed', { errmsg: data.errmsg, parentId })
    return []
  }
  return (data.result ?? []).map((d) => ({
    id: String(d.dept_id ?? ''),
    name: d.name ?? '',
    parentId: d.parent_id != null ? String(d.parent_id) : undefined,
    hasChildren: undefined,
  }))
}

interface DingUser { userid?: string; name?: string }

/**
 * List members of a department, paged by cursor (offset as string).
 *
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listDingtalkDepartmentUsers(
  appKey: string,
  appSecret: string,
  deptId: string,
  cursor?: string
): Promise<DirectoryUserPage> {
  const token = await getAccessToken(appKey, appSecret)
  const offset = cursor ? Number(cursor) : 0
  const size = 50
  const res = await fetch(`${BASE}/topapi/v2/user/list?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: Number(deptId), cursor: offset, size }),
  })
  const data = (await res.json()) as {
    errcode: number
    errmsg?: string
    result?: { hasMore?: boolean; next_cursor?: number; list?: DingUser[] }
  }
  if (data.errcode !== 0) {
    logger.warn('dingtalk list dept users failed', { errmsg: data.errmsg, deptId })
    return { users: [] }
  }
  return {
    users: (data.result?.list ?? []).map((u) => ({ userId: u.userid ?? '', name: u.name ?? '' })),
    nextCursor: data.result?.hasMore ? String(data.result?.next_cursor ?? offset + size) : undefined,
  }
}
