import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listDingtalkDepartmentUsers } from '@/lib/channels/dingtalk-org'
import { listFeishuDepartmentUsers } from '@/lib/channels/feishu-org'
import type { DirectoryUser, DirectoryUserPage } from '@/lib/channels/org-directory-types'
import { listWecomDepartmentUsers } from '@/lib/channels/wecom/org'
import { decryptConfig } from '@/lib/connectors/encryption'

const logger = createLogger('API:ChannelUsers')

/**
 * GET /api/employee/channels/[id]/users
 *
 * Returns the members of a department from the specified org-channel connection.
 * Used by the SOP permission UI's user picker.
 *
 * @param request - Incoming request; carries `deptId` (required), `q?`, `cursor?`
 *   query params.
 * @param params  - Route params containing the connection `id`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePermission('sop:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id: connectionId } = await params
    const searchParams = request.nextUrl.searchParams
    const deptId = searchParams.get('deptId')
    const q = searchParams.get('q') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined

    if (!deptId) {
      return apiOk({ users: [], nextCursor: undefined })
    }

    const [row] = await db
      .select()
      .from(systemConnections)
      .where(eq(systemConnections.id, connectionId))
      .limit(1)

    if (!row) {
      return apiErr('api.channel.notFound', { status: 404 })
    }

    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(decryptConfig(row.configEncrypted)) as Record<string, unknown>
    } catch {
      logger.warn('Failed to decrypt channel config for user listing', { connectionId })
      return apiErr('api.channel.decryptFailed', { status: 500 })
    }

    let page: DirectoryUserPage = { users: [] }

    try {
      switch (row.type) {
        case 'feishu':
          page = await listFeishuDepartmentUsers(
            config.appId as string,
            config.appSecret as string,
            deptId,
            cursor
          )
          break
        case 'dingtalk':
          page = await listDingtalkDepartmentUsers(
            config.appKey as string,
            config.appSecret as string,
            deptId,
            cursor
          )
          break
        case 'wecom':
          page = await listWecomDepartmentUsers(
            config.corpId as string,
            config.corpSecret as string,
            deptId
          )
          break
        default:
          page = { users: [] }
      }
    } catch (err) {
      logger.warn('Channel user listing failed', {
        connectionId,
        type: row.type,
        deptId,
        error: err instanceof Error ? err.message : String(err),
      })
      return apiOk({ users: [], nextCursor: undefined }, { status: 502 })
    }

    /** Apply optional case-insensitive substring filter on name or userId. */
    const users: DirectoryUser[] = q
      ? page.users.filter((u) => {
          const lower = q.toLowerCase()
          return u.name.toLowerCase().includes(lower) || u.userId.toLowerCase().includes(lower)
        })
      : page.users

    return apiOk({ users, nextCursor: page.nextCursor })
  } catch (error) {
    logger.error('Failed to list channel users', error)
    return apiErr('api.channel.fetchDetailFailed', { status: 500 })
  }
}
