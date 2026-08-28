import { db, digitalEmployees, employeeApiKeys, user } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { generateApiKey, hashApiKey, keyPrefix } from '@/lib/tools/api-key-service'

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  userId: z.string().trim().min(1),
})

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('employee:read')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id } = await params
  const rows = await db
    .select({
      id: employeeApiKeys.id,
      name: employeeApiKeys.name,
      userId: employeeApiKeys.userId,
      allowedSupportUserIds: employeeApiKeys.allowedSupportUserIds,
      allowedOrigins: employeeApiKeys.allowedOrigins,
      keyPrefix: employeeApiKeys.keyPrefix,
      active: employeeApiKeys.active,
      createdAt: employeeApiKeys.createdAt,
      lastUsedAt: employeeApiKeys.lastUsedAt,
    })
    .from(employeeApiKeys)
    .where(eq(employeeApiKeys.employeeId, id))
  return apiOk(null, {
    extra: {
      keys: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
    },
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('employee:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id } = await params
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.badRequest', { status: 400 })
  const [[employee], [identity]] = await Promise.all([
    db
      .select({ id: digitalEmployees.id })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, id))
      .limit(1),
    db.select({ id: user.id }).from(user).where(eq(user.id, parsed.data.userId)).limit(1),
  ])
  if (!employee) return apiErr('api.employee.notFound', { status: 404 })
  if (!identity) return apiErr('api.common.invalidParams', { status: 400 })
  const key = generateApiKey()
  const [row] = await db
    .insert(employeeApiKeys)
    .values({
      id: nanoid(),
      employeeId: id,
      name: parsed.data.name,
      userId: parsed.data.userId,
      allowedSupportUserIds: [],
      allowedOrigins: [],
      keyPrefix: keyPrefix(key),
      hashedKey: hashApiKey(key),
    })
    .returning({
      id: employeeApiKeys.id,
      name: employeeApiKeys.name,
      keyPrefix: employeeApiKeys.keyPrefix,
    })
  return apiOk(null, { status: 201, extra: { ...row, key } })
}
