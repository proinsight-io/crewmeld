import { createLogger } from '@crewmeld/logger'
import { callWeComApiWithRetry } from '@/lib/channels/wecom/auth'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'

const logger = createLogger('WecomDirectory')

/** Raw WeCom user.get response fields (beyond errcode/errmsg from the base constraint). */
interface WeComUserFields {
  name?: string
  email?: string
  mobile?: string
  userid?: string
  position?: string
  department?: number[]
  /** Direct leader userid(s); WeCom returns an array, the first is the primary leader. */
  direct_leader?: string[]
}

/** Raw WeCom department.get response fields (beyond errcode/errmsg from the base constraint). */
interface WeComDeptFields {
  department?: Array<{ name?: string }>
}

/**
 * [IM-DIRECTORY · MERGE→dev0.0.1] Fetch a WeCom user's personal info from IM.
 *
 * Fetch a WeCom user's directory detail by userid. Standalone IM capability —
 * no ontology dependency; merges to dev0.0.1.
 *
 * WeCom has no standard job-number field; the userid is the enterprise-unique
 * key and is commonly set to the employee number, so it is reported as
 * employeeNo. Department names are resolved best-effort via department/get.
 *
 * @param corpId - WeCom corp ID
 * @param corpSecret - WeCom app secret
 * @param userId - WeCom userid to look up
 * @returns Mapped ChannelUserDetail, or null if the user is not found or on error
 */
export async function getWecomUserDetail(
  corpId: string,
  corpSecret: string,
  userId: string
): Promise<ChannelUserDetail | null> {
  try {
    const user = await callWeComApiWithRetry<WeComUserFields>(
      corpId,
      corpSecret,
      async (accessToken) => {
        const res = await fetch(
          `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${accessToken}&userid=${userId}`
        )
        return res.json() as Promise<WeComUserFields & { errcode: number; errmsg: string }>
      }
    )

    if (user.errcode !== 0) return null

    const deptNames: string[] = []
    for (const deptId of user.department ?? []) {
      try {
        const dept = await callWeComApiWithRetry<WeComDeptFields>(
          corpId,
          corpSecret,
          async (accessToken) => {
            const res = await fetch(
              `https://qyapi.weixin.qq.com/cgi-bin/department/get?access_token=${accessToken}&id=${deptId}`
            )
            return res.json() as Promise<WeComDeptFields & { errcode: number; errmsg: string }>
          }
        )
        const name = dept.errcode === 0 ? dept.department?.[0]?.name : undefined
        if (name) deptNames.push(name)
      } catch {
        // Best-effort: a single dept lookup failure should not abort the whole call.
      }
    }

    return {
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      employeeNo: user.userid,
      deptNames,
      positions: user.position ? [user.position] : [],
      orgUnitIds: (user.department ?? []).map(String),
      leaderId: user.direct_leader?.[0],
    }
  } catch (error) {
    logger.warn('WeCom user detail failed', { userId, error })
    return null
  }
}
