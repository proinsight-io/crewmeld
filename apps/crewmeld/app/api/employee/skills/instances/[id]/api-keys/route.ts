import { db, toolInstanceApiKeys, toolInstances } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { generateApiKey, hashApiKey, keyPrefix } from '@/lib/tools/api-key-service'

const createSchema = z.object({
  name: z.string().min(1, 'api.skill.apiKeyNameRequired').max(100, 'api.skill.apiKeyNameTooLong'),
})

async function _POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  const [instance] = await db
    .select({ id: toolInstances.id })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!instance) {
    return apiErr('api.skill.instanceNotFound', { status: 404 })
  }

  const body = await request.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return apiErr('api.skill.apiKeyNameRequired', { status: 400 })
  }
  const { name } = parsed.data

  const plaintext = generateApiKey()
  const hashed = hashApiKey(plaintext)
  const prefix = keyPrefix(plaintext)
  const keyId = nanoid()
  const now = new Date()

  await db.insert(toolInstanceApiKeys).values({
    id: keyId,
    instanceId: id,
    name,
    keyPrefix: prefix,
    hashedKey: hashed,
    active: true,
    createdAt: now,
  })

  return apiOk(null, {
    status: 201,
    extra: {
      id: keyId,
      name,
      key: plaintext,
      keyPrefix: prefix,
    },
  })
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  const rows = await db
    .select({
      id: toolInstanceApiKeys.id,
      name: toolInstanceApiKeys.name,
      keyPrefix: toolInstanceApiKeys.keyPrefix,
      active: toolInstanceApiKeys.active,
      createdAt: toolInstanceApiKeys.createdAt,
      lastUsedAt: toolInstanceApiKeys.lastUsedAt,
    })
    .from(toolInstanceApiKeys)
    .where(eq(toolInstanceApiKeys.instanceId, id))

  return apiOk(null, {
    extra: {
      keys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        keyPrefix: r.keyPrefix,
        active: r.active,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      })),
    },
  })
}

export const POST = withAudit(_POST)
