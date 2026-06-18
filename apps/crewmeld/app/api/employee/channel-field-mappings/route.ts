import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { getStoredFieldMap, putFieldMap } from '@/lib/identity/field-map-store'
import type { ChannelFieldMapping } from '@/lib/identity/field-map-types'

const pathSpecSchema = z.union([
  z.object({ kind: z.literal('path'), path: z.string().min(1) }),
  z.object({ kind: z.literal('const'), value: z.string() }),
])

const mappingSchema = z.object({
  fields: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      isCustom: z.boolean(),
      target: z.enum(['scope', 'attributes']),
      valueType: z.enum(['string', 'string[]']),
    }),
  ),
  paths: z.record(z.string(), z.record(z.string(), pathSpecSchema)),
})

/** GET — the persisted global channel field map (seed-merged when empty). */
export async function GET(): Promise<Response> {
  const auth = await requirePermission('channel:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  try {
    return apiOk(await getStoredFieldMap())
  } catch {
    return apiErr('api.channelFieldMap.readFailed', { status: 500 })
  }
}

/** PUT — replace the global field map. */
async function _PUT(request: Request): Promise<Response> {
  const auth = await requirePermission('channel:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiErr('api.channelFieldMap.invalidBody', { status: 400 })
  }
  const parsed = mappingSchema.safeParse(body)
  if (!parsed.success) return apiErr('api.channelFieldMap.invalidConfig', { status: 400 })
  await putFieldMap(parsed.data as ChannelFieldMapping)
  return apiOk({ ok: true })
}

export const PUT = withAudit(_PUT)
