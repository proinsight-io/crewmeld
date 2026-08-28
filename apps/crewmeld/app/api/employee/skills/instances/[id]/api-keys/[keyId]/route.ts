import { db, toolInstanceApiKeys } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

const updateSchema = z.object({ name: z.string().min(1).max(100).optional(), userId: z.string().nullable().optional(), active: z.boolean().optional() })

async function _DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { keyId } = await params

  const [existing] = await db
    .select({ id: toolInstanceApiKeys.id })
    .from(toolInstanceApiKeys)
    .where(eq(toolInstanceApiKeys.id, keyId))
    .limit(1)

  if (!existing) {
    return apiErr('api.skill.apiKeyNotFound', { status: 404 })
  }

  await db.delete(toolInstanceApiKeys).where(eq(toolInstanceApiKeys.id, keyId))

  return apiOk(null, { status: 204 })
}

export const DELETE = withAudit(_DELETE)

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; keyId: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { keyId } = await params
  const parsed = updateSchema.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.skill.apiKeyNameRequired', { status: 400 })
  const [existing] = await db.select({ id: toolInstanceApiKeys.id }).from(toolInstanceApiKeys).where(eq(toolInstanceApiKeys.id, keyId)).limit(1)
  if (!existing) return apiErr('api.skill.apiKeyNotFound', { status: 404 })
  await db.update(toolInstanceApiKeys).set(parsed.data).where(eq(toolInstanceApiKeys.id, keyId))
  return apiOk(null)
}

export const PATCH = withAudit(_PATCH)
