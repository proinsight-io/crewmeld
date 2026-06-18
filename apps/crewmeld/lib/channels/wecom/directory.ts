import { createLogger } from '@crewmeld/logger'
import { callWeComApiWithRetry } from '@/lib/channels/wecom/auth'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'
import { DEFAULT_CHANNEL_FIELD_MAP } from '@/lib/identity/field-map-defaults'
import { normalizeIdentityFromRaw } from '@/lib/identity/normalize'

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
 * [IM-DIRECTORY · MERGE→dev0.0.1] Fetch a WeCom user's raw directory record (+ deptNames, attributes).
 *
 * Returns the channel-native user.get result enriched with best-effort resolved
 * `deptNames` and a non-empty `attributes` pick. Field→identity mapping is applied
 * separately by {@link normalizeIdentityFromRaw}; e.g. employeeNo ← userid (WeCom has
 * no standard job-number field). Department names are resolved best-effort via
 * department/get. Returns null when the user is not found or on error.
 *
 * @param corpId - WeCom corp ID
 * @param corpSecret - WeCom app secret
 * @param userId - WeCom userid to look up
 * @param passthroughFields - Declared custom field names to pick into `attributes`
 * @returns Raw record with deptNames + attributes, or null if not found / on error
 */
export async function getWecomRawRecord(
  corpId: string,
  corpSecret: string,
  userId: string,
  passthroughFields?: string[]
): Promise<Record<string, unknown> | null> {
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
    const rawUser = user as unknown as Record<string, unknown>

    // Pick only the declared custom fields from the raw user object. Custom fields
    // live alongside the known fields, so read it as a record for the by-name pick.
    const attributes: Record<string, unknown> = {}
    for (const f of passthroughFields ?? []) {
      if (f in rawUser) attributes[f] = rawUser[f]
    }

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
      ...rawUser,
      deptNames,
      // Omit the key entirely when no declared field matched (keeps identity lean).
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    }
  } catch (error) {
    logger.warn('WeCom user detail failed', { userId, error })
    return null
  }
}

/**
 * [IM-DIRECTORY · MERGE→dev0.0.1] Fetch a WeCom user's normalized directory detail.
 * Thin wrapper: raw record → {@link normalizeIdentityFromRaw} with the default map.
 */
export async function getWecomUserDetail(
  corpId: string,
  corpSecret: string,
  userId: string,
  passthroughFields?: string[]
): Promise<ChannelUserDetail | null> {
  const raw = await getWecomRawRecord(corpId, corpSecret, userId, passthroughFields)
  return raw ? normalizeIdentityFromRaw(raw, DEFAULT_CHANNEL_FIELD_MAP, 'wecom') : null
}
