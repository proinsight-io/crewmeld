import { db } from '@crewmeld/db'
import { roles } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

const logger = createLogger('RolesAPI')

const VALID_BLOCK_TYPES = ['agent', 'function'] as const

/** GET /api/employee/roles — list all roles ordered by creation date */
export async function GET() {
  try {
    const auth = await requirePermission('employee:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const rows = await db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        persona: roles.persona,
        category: roles.category,
        icon: roles.icon,
        blockType: roles.blockType,
      })
      .from(roles)
      .orderBy(desc(roles.createdAt))

    logger.info(`Fetched roles list: ${rows.length}`)

    return apiOk(rows)
  } catch (error) {
    logger.error('Failed to fetch roles', error)
    return apiErr('api.role.fetchListFailed', { status: 500 })
  }
}

async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('employee:create')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return apiErr('api.role.invalidBody', { status: 400 })
    }

    const { name, description, persona, blockType, category, icon } = body

    if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) {
      return apiErr('api.role.nameInvalid', { status: 400 })
    }

    const resolvedBlockType =
      typeof blockType === 'string' &&
      VALID_BLOCK_TYPES.includes(blockType as (typeof VALID_BLOCK_TYPES)[number])
        ? blockType
        : 'agent'

    const id = `role-${nanoid(10)}`
    const nameStr = name.trim()
    const descStr = typeof description === 'string' ? description.trim() : ''
    const personaStr = typeof persona === 'string' ? persona.trim() : ''
    const categoryStr =
      typeof category === 'string' && category.trim() ? category.trim() : 'general'
    const iconStr = typeof icon === 'string' && icon.trim() ? icon.trim() : null

    await db.insert(roles).values({
      id,
      name: nameStr,
      description: descStr || null,
      persona: personaStr || null,
      blockType: resolvedBlockType,
      category: categoryStr,
      icon: iconStr,
    })

    logger.info(`Role created: ${nameStr} (${id})`)

    return apiOk(
      {
        id,
        name: nameStr,
        description: descStr,
        persona: personaStr,
        blockType: resolvedBlockType,
        category: categoryStr,
        icon: iconStr,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error('Failed to create role', error)
    return apiErr('api.role.createFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
