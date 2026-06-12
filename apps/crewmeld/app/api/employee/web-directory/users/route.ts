import { db } from '@crewmeld/db'
import { user as userTable } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { asc, ilike, or } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

export const dynamic = 'force-dynamic'

const logger = createLogger('API:WebDirectory:Users')

/** Max users returned in one list/search call. */
const LIMIT = 50

/**
 * List platform users for the SOP web-permission user picker. Optional `q`
 * filters by name/email substring (case-insensitive). The returned `userId`
 * matches the web conversation caller id, so it is comparable against the
 * matcher's `employeeId` field.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requirePermission('sop:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const q = request.nextUrl.searchParams.get('q')?.trim()
    const where = q
      ? or(ilike(userTable.name, `%${q}%`), ilike(userTable.email, `%${q}%`))
      : undefined

    const rows = await db
      .select({ userId: userTable.id, name: userTable.name })
      .from(userTable)
      .where(where)
      .orderBy(asc(userTable.name))
      .limit(LIMIT)

    return apiOk({ users: rows })
  } catch (error) {
    logger.error('Failed to list web-directory users', error)
    return apiErr('api.user.fetchListFailed', { status: 500 })
  }
}
