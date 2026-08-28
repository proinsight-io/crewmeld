import { db, employeeApiKeys, user } from '@crewmeld/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { isAllowedOriginPattern, normalizeAllowedOrigins } from '@/lib/employee-api/origin-policy'

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  userId: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
  allowedSupportUserIds: z.array(z.string().min(1)).max(100).optional(),
  allowedOrigins: z.array(z.string().max(300)).max(50).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const auth = await requirePermission('employee:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id, keyId } = await params
  const parsed = patchSchema.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  const userIds = [
    ...(parsed.data.userId ? [parsed.data.userId] : []),
    ...(parsed.data.allowedSupportUserIds ?? []),
  ]
  if (userIds.length > 0) {
    const existing = await db
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, [...new Set(userIds)]))
    if (existing.length !== new Set(userIds).size)
      return apiErr('api.common.invalidParams', { status: 400 })
  }
  const allowedOrigins = parsed.data.allowedOrigins
    ? normalizeAllowedOrigins(parsed.data.allowedOrigins)
    : undefined
  if (allowedOrigins?.some((origin) => !isAllowedOriginPattern(origin)))
    return apiErr('api.common.invalidParams', {
      status: 400,
      extra: { code: 'INVALID_ALLOWED_ORIGIN' },
    })
  const [row] = await db
    .update(employeeApiKeys)
    .set({ ...parsed.data, ...(allowedOrigins ? { allowedOrigins } : {}) })
    .where(and(eq(employeeApiKeys.id, keyId), eq(employeeApiKeys.employeeId, id)))
    .returning({ id: employeeApiKeys.id })
  if (!row) return apiErr('api.common.notFound', { status: 404 })
  return apiOk(null)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const auth = await requirePermission('employee:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id, keyId } = await params
  const result = await db
    .delete(employeeApiKeys)
    .where(and(eq(employeeApiKeys.id, keyId), eq(employeeApiKeys.employeeId, id)))
    .returning({ id: employeeApiKeys.id })
  if (result.length === 0) return apiErr('api.common.notFound', { status: 404 })
  return apiOk(null)
}
