import { db } from '@crewmeld/db'
import { SOP_TERMINAL_STATUSES, sopDefinitions, sopExecutions } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq, notInArray } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { SopVisibilityRules } from '@/lib/sop/visibility-types'
import type { SopDefinitionPayload } from '@/types/sop'

const logger = createLogger('API:Sops:Detail')

/** Request body accepted by the PATCH endpoint. */
type SopPatchBody = Partial<SopDefinitionPayload> & { visibilityRules?: SopVisibilityRules | null }

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('sop:list')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    const rows = await db.select().from(sopDefinitions).where(eq(sopDefinitions.id, id))
    const definition = rows[0]

    if (!definition) {
      return apiErr('api.sop.notFound', { status: 404 })
    }

    return apiOk(definition)
  } catch (error) {
    logger.error('Failed to fetch SOP detail', error)
    return apiErr('api.sop.fetchDetailFailed', { status: 500 })
  }
}

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('sop:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const body = (await request.json()) as SopPatchBody

    const VALID_TRIGGER_TYPES = ['scheduled', 'event', 'manual'] as const
    if (
      body.triggerType &&
      !VALID_TRIGGER_TYPES.includes(body.triggerType as (typeof VALID_TRIGGER_TYPES)[number])
    ) {
      return apiErr('api.sop.invalidTriggerType', { status: 400 })
    }

    const rows = await db.select().from(sopDefinitions).where(eq(sopDefinitions.id, id))
    const existing = rows[0]

    if (!existing) {
      return apiErr('api.sop.notFound', { status: 404 })
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    // Definition fields — bump version when any of these change
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.description !== undefined) updates.description = body.description
    if (body.triggerType !== undefined) updates.triggerType = body.triggerType
    if (body.triggerConfig !== undefined) updates.triggerConfig = body.triggerConfig
    if (body.nodes !== undefined) updates.nodes = body.nodes
    if (body.edges !== undefined) updates.edges = body.edges
    if (body.sopTimeoutMinutes !== undefined) updates.sopTimeoutMinutes = body.sopTimeoutMinutes
    if (body.maxRejectionCycles !== undefined) updates.maxRejectionCycles = body.maxRejectionCycles
    if (body.maxRetries !== undefined) updates.maxRetries = body.maxRetries

    // Status toggle — not a definition change, no version bump
    if (body.isActive !== undefined) updates.isActive = body.isActive

    // Visibility rules — permission metadata, not a definition change, no version bump
    if (body.visibilityRules !== undefined) {
      updates.visibilityRules = body.visibilityRules as SopVisibilityRules | null
    }

    // Bump version only when definition fields changed
    const hasDefinitionChange = Object.keys(updates).some(
      (k) => k !== 'updatedAt' && k !== 'isActive' && k !== 'visibilityRules'
    )
    const newVersion = hasDefinitionChange ? existing.version + 1 : existing.version
    if (hasDefinitionChange) updates.version = newVersion

    await db.update(sopDefinitions).set(updates).where(eq(sopDefinitions.id, id))

    logger.info('SOP updated', { sopId: id, version: newVersion })

    return apiOk({ id, version: newVersion })
  } catch (error) {
    logger.error('Failed to update SOP', error)
    return apiErr('api.sop.updateFailed', { status: 500 })
  }
}

async function _DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('sop:delete')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params

    await db
      .update(sopExecutions)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(sopExecutions.sopDefinitionId, id),
          notInArray(sopExecutions.status, SOP_TERMINAL_STATUSES)
        )
      )

    const deleted = await db
      .delete(sopDefinitions)
      .where(eq(sopDefinitions.id, id))
      .returning({ id: sopDefinitions.id })

    if (deleted.length === 0) {
      return apiErr('api.sop.notFound', { status: 404 })
    }

    logger.info('SOP deleted', { sopId: id })

    return apiOk(null)
  } catch (error) {
    logger.error('Failed to delete SOP', error)
    return apiErr('api.sop.deleteFailed', { status: 500 })
  }
}

export const PATCH = withAudit(_PATCH)
export const DELETE = withAudit(_DELETE)
