import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { listDingtalkDepartments } from '@/lib/channels/dingtalk-org'
import { listFeishuDepartments } from '@/lib/channels/feishu-org'
import type { DepartmentNode } from '@/lib/channels/org-directory-types'
import { listWecomDepartments } from '@/lib/channels/wecom/org'
import { decryptConfig } from '@/lib/connectors/encryption'

const logger = createLogger('API:ChannelDepartments')

/**
 * GET /api/employee/channels/[id]/departments
 *
 * Returns the direct child departments of `parentId` from the specified
 * org-channel connection. Used by the SOP permission UI's department picker.
 *
 * @param request - Incoming request; may carry `parentId` query param.
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
    const parentId = request.nextUrl.searchParams.get('parentId') ?? undefined

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
      logger.warn('Failed to decrypt channel config for department listing', { connectionId })
      return apiErr('api.channel.decryptFailed', { status: 500 })
    }

    let items: DepartmentNode[] = []

    try {
      switch (row.type) {
        case 'feishu':
          items = await listFeishuDepartments(
            config.appId as string,
            config.appSecret as string,
            parentId ?? '0'
          )
          break
        case 'dingtalk':
          items = await listDingtalkDepartments(
            config.appKey as string,
            config.appSecret as string,
            parentId ?? '1'
          )
          break
        case 'wecom':
          items = await listWecomDepartments(
            config.corpId as string,
            config.corpSecret as string,
            parentId ?? '1'
          )
          break
        default:
          items = []
      }
    } catch (err) {
      logger.warn('Channel department listing failed', {
        connectionId,
        type: row.type,
        error: err instanceof Error ? err.message : String(err),
      })
      return apiOk({ items: [] }, { status: 502 })
    }

    return apiOk({ items })
  } catch (error) {
    logger.error('Failed to list channel departments', error)
    return apiErr('api.channel.fetchDetailFailed', { status: 500 })
  }
}
