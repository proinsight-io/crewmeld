/**
 * DingTalk API client - access_token management + message sending
 *
 * DingTalk API docs: https://open.dingtalk.com/document/orgapp
 */

import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'

const logger = createLogger('DingtalkClient')

const DINGTALK_API_BASE = 'https://api.dingtalk.com'
const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com'

/** Token cache (appKey -> { token, expiresAt }) */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Token early refresh margin (seconds) */
const TOKEN_REFRESH_MARGIN_S = 300

/**
 * Get access_token (auto-cached + refreshed)
 */
export async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appKey)
  if (cached && cached.expiresAt > Date.now() / 1000 + TOKEN_REFRESH_MARGIN_S) {
    return cached.token
  }

  const res = await fetch(
    `${DINGTALK_OAPI_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
  )

  const data = (await res.json()) as {
    errcode: number
    errmsg: string
    access_token: string
    expires_in: number
  }

  if (data.errcode !== 0) {
    throw new Error(`${t('channelDingtalkTokenFailed')}: ${data.errmsg}`)
  }

  tokenCache.set(appKey, {
    token: data.access_token,
    expiresAt: Date.now() / 1000 + data.expires_in,
  })

  logger.info('DingTalk access_token refreshed', { appKey })
  return data.access_token
}

interface DingtalkApiResult {
  errcode?: number
  errmsg?: string
  [key: string]: unknown
}

/**
 * Call DingTalk API (auto-attaches token + retries once on failure)
 */
export async function callDingtalkApi<T extends DingtalkApiResult>(
  appKey: string,
  appSecret: string,
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  let token = await getAccessToken(appKey, appSecret)

  let res = await fetch(
    url.includes('?') ? `${url}&access_token=${token}` : `${url}?access_token=${token}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )

  let result = (await res.json()) as T

  // Retry once when token expires
  if (result.errcode === 40014 || result.errcode === 42001) {
    tokenCache.delete(appKey)
    token = await getAccessToken(appKey, appSecret)

    res = await fetch(
      url.includes('?') ? `${url}&access_token=${token}` : `${url}?access_token=${token}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    result = (await res.json()) as T
  }

  return result
}

/**
 * Send direct message via new API (requires robotCode)
 *
 * Docs: https://open.dingtalk.com/document/orgapp/the-robot-sends-a-one-on-one-chat-message
 */
export async function sendSingleChatMessage(
  appKey: string,
  appSecret: string,
  robotCode: string,
  userIds: string[],
  msgKey: string,
  msgParam: string
): Promise<string | undefined> {
  const token = await getAccessToken(appKey, appSecret)

  const res = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgKey,
      msgParam,
    }),
  })

  const result = (await res.json()) as { processQueryKey?: string; invalidStaffIdList?: string[] }

  if (!res.ok) {
    logger.error('DingTalk direct message send failed', { status: res.status, result })
    throw new Error(`${t('channelDingtalkDmFailed')}: ${JSON.stringify(result)}`)
  }

  logger.info('DingTalk direct message sent successfully', { userIds, msgKey })
  return result.processQueryKey
}

/**
 * Send group chat message via new API
 *
 * Docs: https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-chat-message
 */
export async function sendGroupChatMessage(
  appKey: string,
  appSecret: string,
  robotCode: string,
  openConversationId: string,
  msgKey: string,
  msgParam: string
): Promise<string | undefined> {
  const token = await getAccessToken(appKey, appSecret)

  const res = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode,
      openConversationId,
      msgKey,
      msgParam,
    }),
  })

  const result = (await res.json()) as { processQueryKey?: string }

  if (!res.ok) {
    logger.error('DingTalk group message send failed', { status: res.status, result })
    throw new Error(`${t('channelDingtalkGroupFailed')}: ${JSON.stringify(result)}`)
  }

  logger.info('DingTalk group message sent successfully', { openConversationId, msgKey })
  return result.processQueryKey
}

/**
 * Send message to group via legacy webhook (custom robot)
 */
export async function sendWebhookMessage(
  webhookUrl: string,
  msgtype: 'text' | 'markdown' | 'actionCard' | 'link',
  content: Record<string, unknown>
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype, [msgtype]: content }),
  })

  const result = (await res.json()) as { errcode: number; errmsg: string }

  if (result.errcode !== 0) {
    logger.error('DingTalk webhook message send failed', {
      errcode: result.errcode,
      errmsg: result.errmsg,
    })
    throw new Error(`${t('channelDingtalkOtoFailed')}: ${result.errmsg}`)
  }
}

/**
 * Upload file to DingTalk (get mediaId for robot file messages)
 *
 * Docs: https://open.dingtalk.com/document/orgapp/upload-to-dingtalk-server
 */
export async function uploadRobotFile(
  appKey: string,
  appSecret: string,
  fileName: string,
  fileBuffer: Buffer
): Promise<string> {
  const token = await getAccessToken(appKey, appSecret)

  // Upload via FormData
  const formData = new FormData()
  formData.append('type', 'file')
  formData.append('media', new Blob([fileBuffer as BlobPart]), fileName)

  const res = await fetch(`${DINGTALK_OAPI_BASE}/media/upload?access_token=${token}&type=file`, {
    method: 'POST',
    body: formData,
  })

  const result = (await res.json()) as { errcode: number; errmsg: string; media_id?: string }

  if (result.errcode !== 0 || !result.media_id) {
    logger.error('DingTalk file upload failed', { errcode: result.errcode, errmsg: result.errmsg })
    throw new Error(`${t('channelDingtalkUploadFailed')}: ${result.errmsg}`)
  }

  logger.info('DingTalk file uploaded successfully', { fileName, mediaId: result.media_id })
  return result.media_id
}

/**
 * Download file from DingTalk robot message
 *
 * Docs: https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message
 */
export async function downloadRobotFile(
  appKey: string,
  appSecret: string,
  downloadCode: string,
  robotCode: string
): Promise<Buffer> {
  const token = await getAccessToken(appKey, appSecret)

  const res = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/messageFiles/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({ downloadCode, robotCode }),
  })

  if (!res.ok) {
    throw new Error(`${t('channelDingtalkDownloadFailed')}: ${res.status}`)
  }

  // API returns JSON { downloadUrl: "..." }, requires a second download for the actual file
  const data = (await res.json()) as { downloadUrl?: string }
  if (!data.downloadUrl) {
    throw new Error(t('channelDingtalkDownloadNoUrl'))
  }

  const fileRes = await fetch(data.downloadUrl)
  if (!fileRes.ok) {
    throw new Error(`${t('channelDingtalkContentFailed')}: ${fileRes.status}`)
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer())
  logger.info('DingTalk file downloaded successfully', { size: buffer.length })
  return buffer
}

/**
 * [IM-DIRECTORY · MERGE→dev0.0.1] Fetch a DingTalk user's personal info from IM.
 *
 * Fetch a DingTalk user's directory detail by staffId (userId). Standalone IM
 * capability — no ontology dependency; merges to dev0.0.1. Best-effort:
 * returns null when the lookup fails. Dept names resolved best-effort via
 * topapi/v2/department/get; failures omit the name.
 */
export async function getDingtalkUserDetail(
  appKey: string,
  appSecret: string,
  userId: string
): Promise<ChannelUserDetail | null> {
  const result = await callDingtalkApi<
    DingtalkApiResult & {
      result?: {
        name?: string
        email?: string
        mobile?: string
        job_number?: string
        title?: string
        dept_id_list?: number[]
        /** Direct manager's userid (钉钉 "直属主管"). */
        manager_userid?: string
      }
    }
  >(appKey, appSecret, `${DINGTALK_OAPI_BASE}/topapi/v2/user/get`, { userid: userId })
  if (result.errcode !== 0 || !result.result) return null
  const u = result.result

  const deptNames: string[] = []
  for (const deptId of u.dept_id_list ?? []) {
    try {
      const dr = await callDingtalkApi<DingtalkApiResult & { result?: { name?: string } }>(
        appKey,
        appSecret,
        `${DINGTALK_OAPI_BASE}/topapi/v2/department/get`,
        { dept_id: deptId }
      )
      if (dr.errcode === 0 && dr.result?.name) deptNames.push(dr.result.name)
    } catch {
      // Best-effort.
    }
  }

  return {
    name: u.name,
    email: u.email,
    mobile: u.mobile,
    employeeNo: u.job_number,
    deptNames,
    positions: u.title ? [u.title] : [],
    orgUnitIds: (u.dept_id_list ?? []).map(String),
    leaderId: u.manager_userid,
  }
}

/**
 * Get DingTalk user name by staffId (userId)
 */
export async function getDingtalkUserName(
  appKey: string,
  appSecret: string,
  userId: string
): Promise<string | null> {
  try {
    const result = await callDingtalkApi<DingtalkApiResult & { result?: { name?: string } }>(
      appKey,
      appSecret,
      `${DINGTALK_OAPI_BASE}/topapi/v2/user/get`,
      { userid: userId }
    )

    if (result.errcode === 0 && result.result?.name) {
      logger.info('DingTalk user name retrieved successfully', { userId, name: result.result.name })
      return result.result.name
    }

    logger.info('DingTalk user name retrieval failed', {
      errcode: result.errcode,
      errmsg: result.errmsg,
      userId,
    })
  } catch (error) {
    logger.warn('DingTalk user name retrieval error', { userId, error })
  }

  return null
}
