/**
 * WeCom org-structure listing for SOP permission pickers.
 * Reuses {@link callWeComApiWithRetry} from wecom/auth — the real helper takes
 * a callback `(accessToken: string) => Promise<T>` rather than a path string.
 *
 * Docs:
 *   - cgi-bin/department/simplelist  (list child department ids + names)
 *   - cgi-bin/user/simplelist        (list direct members of a department)
 *
 * WeCom returns the full sub-tree in one call for these endpoints (no pagination).
 */

import { createLogger } from '@crewmeld/logger'
import { callWeComApiWithRetry } from './auth'
import type { DepartmentNode, DirectoryUserPage } from '../org-directory-types'

const logger = createLogger('WecomOrg')

const WECOM_BASE = 'https://qyapi.weixin.qq.com'

interface WecomDept { id?: number; name?: string; parentid?: number }

/**
 * List child departments under `parentId` ('1' = root).
 *
 * WeCom `simplelist?id=parentId` returns the full subtree rooted at `parentId`.
 * We filter out the parent node itself, then compute `hasChildren` by checking
 * whether any other department in the returned set has this node as its parent.
 *
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listWecomDepartments(
  corpId: string,
  corpSecret: string,
  parentId = '1'
): Promise<DepartmentNode[]> {
  const data = await callWeComApiWithRetry<{ department_id?: WecomDept[]; errmsg: string }>(
    corpId,
    corpSecret,
    async (accessToken) => {
      const res = await fetch(
        `${WECOM_BASE}/cgi-bin/department/simplelist?access_token=${accessToken}&id=${encodeURIComponent(parentId)}`
      )
      return res.json() as Promise<{ errcode: number; errmsg: string; department_id?: WecomDept[] }>
    }
  )
  if (data.errcode !== 0) {
    logger.warn('wecom list departments failed', { errmsg: data.errmsg, parentId })
    return []
  }
  const allDepts = data.department_id ?? []
  // Build the set of parentid values present in the raw result so we can
  // determine which nodes have at least one child in the returned subtree.
  const parentIdSet = new Set(allDepts.map((d) => String(d.parentid ?? '')))
  return allDepts
    .filter((d) => String(d.id) !== String(parentId))
    .map((d) => ({
      id: String(d.id ?? ''),
      name: d.name ?? '',
      parentId: d.parentid != null ? String(d.parentid) : undefined,
      hasChildren: parentIdSet.has(String(d.id ?? '')),
    }))
}

interface WecomUser { userid?: string; name?: string }

/**
 * List members directly under a department (single page; WeCom returns all).
 *
 * @throws when the channel API token fetch or HTTP request fails (caller — the BFF route — maps this to a 5xx).
 */
export async function listWecomDepartmentUsers(
  corpId: string,
  corpSecret: string,
  deptId: string
): Promise<DirectoryUserPage> {
  const data = await callWeComApiWithRetry<{ userlist?: WecomUser[]; errmsg: string }>(
    corpId,
    corpSecret,
    async (accessToken) => {
      const res = await fetch(
        `${WECOM_BASE}/cgi-bin/user/simplelist?access_token=${accessToken}&department_id=${encodeURIComponent(deptId)}&fetch_child=0`
      )
      return res.json() as Promise<{ errcode: number; errmsg: string; userlist?: WecomUser[] }>
    }
  )
  if (data.errcode !== 0) {
    logger.warn('wecom list dept users failed', { errmsg: data.errmsg, deptId })
    return { users: [] }
  }
  return {
    users: (data.userlist ?? []).map((u) => ({ userId: u.userid ?? '', name: u.name ?? '' })),
  }
}
