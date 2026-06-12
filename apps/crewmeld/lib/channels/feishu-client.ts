/**
 * Feishu API client - tenant_access_token management + message sending
 *
 * Feishu API docs: https://open.feishu.cn/document/server-docs
 */

import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'

const logger = createLogger('FeishuClient')

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis'

/** Token cache (appId -> { token, expiresAt }) */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Token early refresh margin (seconds) */
const TOKEN_REFRESH_MARGIN_S = 300

/**
 * Get tenant_access_token (auto-cached + refreshed)
 */
export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appId)
  if (cached && cached.expiresAt > Date.now() / 1000 + TOKEN_REFRESH_MARGIN_S) {
    return cached.token
  }

  const res = await fetch(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })

  const data = (await res.json()) as {
    code: number
    msg: string
    tenant_access_token: string
    expire: number
  }

  if (data.code !== 0) {
    throw new Error(`${t('channelFeishuTokenFailed')}: ${data.msg}`)
  }

  tokenCache.set(appId, {
    token: data.tenant_access_token,
    expiresAt: Date.now() / 1000 + data.expire,
  })

  logger.info('Feishu tenant_access_token refreshed', { appId })
  return data.tenant_access_token
}

interface FeishuApiResult {
  code: number
  msg: string
  data?: Record<string, unknown>
}

/**
 * Call Feishu API (auto-attaches token + retries once on failure)
 */
export async function callFeishuApi<T extends FeishuApiResult>(
  appId: string,
  appSecret: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  let token = await getTenantAccessToken(appId, appSecret)

  let res = await fetch(`${FEISHU_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  let result = (await res.json()) as T

  // Retry once when token expires
  if (result.code === 99991663 || result.code === 99991661) {
    tokenCache.delete(appId)
    token = await getTenantAccessToken(appId, appSecret)

    res = await fetch(`${FEISHU_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    result = (await res.json()) as T
  }

  return result
}

/**
 * Get Feishu user name by open_id
 *
 * Strategy chain (by priority):
 * 1. Contact API GET /contact/v3/users/{open_id} (requires contact:user.base:readonly)
 * 2. Chat member API GET /im/v1/chats/{chat_id}/members (only needs im:chat:readonly, bot has by default)
 *
 * Returns null when all strategies fail; caller handles fallback.
 */
export async function getFeishuUserName(
  appId: string,
  appSecret: string,
  openId: string,
  chatId?: string
): Promise<string | null> {
  const token = await getTenantAccessToken(appId, appSecret)

  // Strategy 1: Contact API (most direct, but requires contact permissions)
  try {
    const res = await fetch(
      `${FEISHU_BASE_URL}/contact/v3/users/${openId}?id_type=open_id&user_id_type=open_id`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    const result = (await res.json()) as {
      code: number
      msg: string
      data?: { user?: { name?: string } }
    }

    if (result.code === 0 && result.data?.user?.name) {
      logger.info('Feishu user name retrieved (Contact API)', {
        openId,
        name: result.data.user.name,
      })
      return result.data.user.name
    }

    logger.info('Feishu Contact API did not return name', {
      code: result.code,
      msg: result.msg,
      openId,
    })
  } catch (error) {
    logger.info('Feishu Contact API call failed', { openId, error })
  }

  // Strategy 2: Get name from chat member list (bot has im:chat:readonly by default)
  if (chatId) {
    try {
      const res = await fetch(
        `${FEISHU_BASE_URL}/im/v1/chats/${chatId}/members?member_id_type=open_id`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }
      )

      const result = (await res.json()) as {
        code: number
        msg: string
        data?: { items?: Array<{ member_id?: string; name?: string; member_id_type?: string }> }
      }

      if (result.code === 0 && result.data?.items) {
        const member = result.data.items.find((m) => m.member_id === openId)
        if (member?.name) {
          logger.info('Feishu user name retrieved (Chat Member API)', {
            openId,
            chatId,
            name: member.name,
          })
          return member.name
        }
      }

      logger.info('Feishu Chat Member API did not match user', {
        code: result.code,
        msg: result.msg,
        openId,
        chatId,
      })
    } catch (error) {
      logger.info('Feishu Chat Member API call failed', { openId, chatId, error })
    }
  }

  logger.warn('All Feishu user name strategies failed', { openId, chatId })
  return null
}

/**
 * Org profile of a Feishu user, sourced from the Contact API.
 *
 * Note: "role" (功能角色 / functional role) is intentionally absent — Feishu
 * provides no reverse "roles by user" lookup, so it would require enumerating
 * every functional role's member list. Left as a future addition.
 */
export interface FeishuUserProfile {
  /** Display name */
  name: string | null
  /** Primary email; falls back to enterprise email */
  email: string | null
  /** Mobile number */
  mobile: string | null
  /** Employee number (工号) */
  employeeNo: string | null
  /** Job title — maps to the Feishu "职务" field (requires contact:user.employee:readonly) */
  jobTitle: string | null
  /** Employee type: 1=full-time, 2=intern, 3=outsourced, 4=labor, 5=consultant, or a custom code */
  employeeType: number | null
  /** Open IDs (`od-…`) of the departments the user belongs to — the id space used for matching. */
  departmentIds: string[]
  /** Best-effort resolved department names; empty when the departments scope is missing */
  departmentNames: string[]
  /**
   * Tenant custom department ids (e.g. `beijing`) resolved alongside the names.
   * Recorded for display/audit only — NOT used for SOP permission matching, which
   * stays on the open_department_id space. Empty when no department exposes a
   * custom id (or the departments scope is missing).
   */
  departmentCustomIds: string[]
  /** Direct leader's id, in the same id space as `leaderIdType` — used for approval routing */
  leaderId: string | null
  /** Id type of `leaderId` and the queried user; matches the input id's format */
  leaderIdType: 'open_id' | 'union_id' | 'user_id'
}

/**
 * Infer a Feishu id type from its prefix.
 *
 * open_id starts with `ou_`, union_id with `on_`; anything else is a user_id.
 * The Contact API needs this so the path id is interpreted correctly and the
 * returned ids (e.g. leader_user_id) come back in the same id space.
 */
function inferUserIdType(id: string): 'open_id' | 'union_id' | 'user_id' {
  if (id.startsWith('ou_')) return 'open_id'
  if (id.startsWith('on_')) return 'union_id'
  return 'user_id'
}

/**
 * Resolve a department open ID to its display name (best-effort).
 *
 * Returns null on any failure so a missing departments scope never breaks
 * the surrounding profile fetch.
 */
async function getFeishuDepartmentName(token: string, departmentId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${FEISHU_BASE_URL}/contact/v3/departments/${departmentId}?department_id_type=open_department_id`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    const result = (await res.json()) as {
      code: number
      msg: string
      data?: { department?: { name?: string } }
    }

    if (result.code === 0 && result.data?.department?.name) {
      return result.data.department.name
    }

    logger.info('Feishu department name lookup did not return a name', {
      code: result.code,
      msg: result.msg,
      departmentId,
    })
    return null
  } catch (error) {
    logger.info('Feishu department name lookup failed', { departmentId, error })
    return null
  }
}

/**
 * Resolve a user's department memberships in the tenant `department_id` space
 * (the human-set custom ids, e.g. `beijing`) via a second Contact API lookup.
 *
 * The primary profile fetch uses `department_id_type=open_department_id`, so its
 * `departmentIds` are `od-…` (the id space used for matching). This companion
 * call re-queries the SAME user with `department_id_type=department_id`; per the
 * Feishu docs the user endpoint's `department_ids` format follows that
 * parameter, so it returns the custom ids directly. (The department-detail
 * endpoint is NOT a reliable source — its `department_id` field mirrors the
 * queried id type, returning `od-…` in open mode.)
 *
 * Recorded only, never used for matching. Best-effort: returns [] on any
 * failure; the tenant root department "0" is filtered out.
 */
async function getFeishuUserCustomDepartmentIds(
  token: string,
  userId: string,
  userIdType: 'open_id' | 'union_id' | 'user_id'
): Promise<string[]> {
  try {
    const res = await fetch(
      `${FEISHU_BASE_URL}/contact/v3/users/${userId}?user_id_type=${userIdType}&department_id_type=department_id`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    const result = (await res.json()) as {
      code: number
      msg: string
      data?: { user?: { department_ids?: string[] } }
    }

    if (result.code === 0 && result.data?.user?.department_ids) {
      return result.data.user.department_ids.filter((id) => id !== '0')
    }

    logger.info('Feishu custom department id lookup did not return departments', {
      code: result.code,
      msg: result.msg,
      userId,
    })
    return []
  } catch (error) {
    logger.info('Feishu custom department id lookup failed', { userId, error })
    return []
  }
}

/**
 * Fetch a Feishu user's org profile by id (open_id / union_id / user_id).
 *
 * The id type is inferred from the id's prefix, so the same call works whether
 * the inbound event carried an open_id or fell back to a user_id. A single
 * Contact API call returns name / job title / employee type / department IDs /
 * leader; `leaderId` comes back in the same id space as the input.
 *
 * Department names are resolved with extra best-effort calls; they stay empty
 * when the departments scope is not granted.
 *
 * Returns null when the user lookup itself fails (missing scope or bad id).
 */
export async function getFeishuUserProfile(
  appId: string,
  appSecret: string,
  userId: string
): Promise<FeishuUserProfile | null> {
  const token = await getTenantAccessToken(appId, appSecret)
  const userIdType = inferUserIdType(userId)

  const res = await fetch(
    `${FEISHU_BASE_URL}/contact/v3/users/${userId}?user_id_type=${userIdType}&department_id_type=open_department_id`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  )

  const result = (await res.json()) as {
    code: number
    msg: string
    data?: {
      user?: {
        name?: string
        email?: string
        enterprise_email?: string
        mobile?: string
        employee_no?: string
        job_title?: string
        employee_type?: number
        department_ids?: string[]
        leader_user_id?: string
      }
    }
  }

  if (result.code !== 0 || !result.data?.user) {
    logger.warn('Feishu user profile fetch failed', {
      code: result.code,
      msg: result.msg,
      userId,
      userIdType,
    })
    return null
  }

  const user = result.data.user
  const departmentIds = user.department_ids ?? []
  // "0" is the tenant root department, not a real org unit — skip its name lookup.
  const departmentNames = (
    await Promise.all(
      departmentIds.filter((id) => id !== '0').map((id) => getFeishuDepartmentName(token, id))
    )
  ).filter((name): name is string => name !== null)
  // Custom (tenant) department ids come from a second user lookup in the
  // department_id space — recorded only, never used for matching.
  const departmentCustomIds = await getFeishuUserCustomDepartmentIds(token, userId, userIdType)

  return {
    name: user.name ?? null,
    email: user.email ?? user.enterprise_email ?? null,
    mobile: user.mobile ?? null,
    employeeNo: user.employee_no ?? null,
    jobTitle: user.job_title ?? null,
    employeeType: user.employee_type ?? null,
    departmentIds,
    departmentNames,
    departmentCustomIds,
    leaderId: user.leader_user_id ?? null,
    leaderIdType: userIdType,
  }
}

/**
 * Send message (supports open_id / chat_id)
 *
 * @param receiveIdType - 'open_id' | 'chat_id' | 'user_id'
 */
export async function sendMessage(
  appId: string,
  appSecret: string,
  receiveId: string,
  receiveIdType: 'open_id' | 'chat_id' | 'user_id',
  msgType: string,
  content: string
): Promise<string | undefined> {
  const result = await callFeishuApi<FeishuApiResult & { data?: { message_id?: string } }>(
    appId,
    appSecret,
    `/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: msgType,
      content,
    }
  )

  if (result.code !== 0) {
    logger.error('Feishu message send failed', { code: result.code, msg: result.msg, receiveId })
    throw new Error(`${t('channelFeishuSendFailed')}: ${result.msg}`)
  }

  const messageId = result.data?.message_id as string | undefined
  logger.info('Feishu message sent successfully', { receiveId, messageId })
  return messageId
}

/**
 * Reply to a message (reply to message_id)
 */
export async function replyMessage(
  appId: string,
  appSecret: string,
  messageId: string,
  msgType: string,
  content: string
): Promise<string | undefined> {
  const result = await callFeishuApi<FeishuApiResult & { data?: { message_id?: string } }>(
    appId,
    appSecret,
    `/im/v1/messages/${messageId}/reply`,
    {
      msg_type: msgType,
      content,
    }
  )

  if (result.code !== 0) {
    logger.error('Feishu message reply failed', { code: result.code, msg: result.msg, messageId })
    throw new Error(`${t('channelFeishuReplyFailed')}: ${result.msg}`)
  }

  return result.data?.message_id as string | undefined
}

/**
 * Upload file to Feishu, returns file_key
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/file/create
 */
export async function uploadFile(
  appId: string,
  appSecret: string,
  fileName: string,
  fileBuffer: Buffer,
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream'
): Promise<string> {
  const token = await getTenantAccessToken(appId, appSecret)

  const formData = new FormData()
  formData.append('file_type', fileType)
  formData.append('file_name', fileName)
  formData.append('file', new Blob([new Uint8Array(fileBuffer)]), fileName)

  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })

  const result = (await res.json()) as FeishuApiResult & { data?: { file_key?: string } }

  if (result.code !== 0 || !result.data?.file_key) {
    throw new Error(`${t('channelFeishuUploadFailed')}: ${result.msg} (code=${result.code})`)
  }

  logger.info('Feishu file uploaded successfully', { fileName, fileKey: result.data.file_key })
  return result.data.file_key
}

/**
 * Download file resource from a message
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-attachment/get
 */
export async function downloadMessageFile(
  appId: string,
  appSecret: string,
  messageId: string,
  fileKey: string
): Promise<Buffer> {
  const token = await getTenantAccessToken(appId, appSecret)

  const res = await fetch(
    `${FEISHU_BASE_URL}/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  )

  if (!res.ok) {
    throw new Error(`${t('channelFeishuDownloadFailed')}: HTTP ${res.status}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  logger.info('Feishu file downloaded successfully', {
    messageId,
    fileKey,
    size: arrayBuffer.byteLength,
  })
  return Buffer.from(arrayBuffer)
}

/**
 * Send file message
 */
export async function sendFileMessage(
  appId: string,
  appSecret: string,
  receiveId: string,
  receiveIdType: 'open_id' | 'chat_id' | 'user_id',
  fileKey: string
): Promise<string | undefined> {
  return sendMessage(
    appId,
    appSecret,
    receiveId,
    receiveIdType,
    'file',
    JSON.stringify({ file_key: fileKey })
  )
}

/**
 * Update message card content (for streaming updates or approval status changes)
 */
export async function updateMessageCard(
  appId: string,
  appSecret: string,
  messageId: string,
  cardContent: Record<string, unknown>
): Promise<void> {
  const token = await getTenantAccessToken(appId, appSecret)

  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      content: JSON.stringify(cardContent),
    }),
  })

  const result = (await res.json()) as FeishuApiResult

  if (result.code !== 0) {
    logger.warn('Feishu card update failed', { code: result.code, msg: result.msg, messageId })
  }
}

/**
 * [IM-DIRECTORY · MERGE→dev0.0.1] Fetch a Feishu user's personal info from IM.
 *
 * Thin adapter over {@link getFeishuUserProfile}: one Contact API call yields
 * every directory field, so this maps the richer profile down to the
 * cross-channel {@link ChannelUserDetail} shape (positions ← job title,
 * orgUnitIds ← department ids, leaderId ← direct leader).
 *
 * Best-effort: returns null when the Contact API does not return a user (e.g.
 * missing contact permission).
 */
export async function getFeishuUserDetail(
  appId: string,
  appSecret: string,
  openId: string
): Promise<ChannelUserDetail | null> {
  const profile = await getFeishuUserProfile(appId, appSecret, openId)
  if (!profile) return null

  return {
    name: profile.name ?? undefined,
    email: profile.email ?? undefined,
    mobile: profile.mobile ?? undefined,
    employeeNo: profile.employeeNo ?? undefined,
    employeeType: profile.employeeType != null ? String(profile.employeeType) : undefined,
    deptNames: profile.departmentNames,
    positions: profile.jobTitle ? [profile.jobTitle] : [],
    orgUnitIds: profile.departmentIds,
    orgUnitCustomIds: profile.departmentCustomIds,
    leaderId: profile.leaderId ?? undefined,
  }
}
