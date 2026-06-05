import { db, toolInstances } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

const patchSchema = z.object({
  publishedAsApi: z.boolean(),
})

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params
  const body = await request.json()
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return apiErr('api.common.badRequest', { status: 400 })
  }
  const { publishedAsApi } = parsed.data

  const [existing] = await db
    .select({ id: toolInstances.id })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!existing) {
    return apiErr('api.skill.instanceNotFound', { status: 404 })
  }

  await db
    .update(toolInstances)
    .set({ publishedAsApi, updatedAt: new Date() })
    .where(eq(toolInstances.id, id))

  return apiOk(null, { extra: { publishedAsApi } })
}

export const PATCH = withAudit(_PATCH)
