import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { mergeQuestionGroups } from '@/lib/knowledge/analytics/repository'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'

const Body = z.object({
  ids: z.array(z.string().min(1)).min(2).max(100),
  canonicalQuestion: z.string().min(1).max(2000).optional(),
})

export const POST = withAudit(async (request: Request) => {
  const auth = await requirePermission(QA_PERMISSIONS.edit)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  try {
    return apiOk(
      await mergeQuestionGroups(parsed.data.ids, parsed.data.canonicalQuestion, auth.userId!)
    )
  } catch (error) {
    return apiErr('api.common.invalidParams', {
      status: 409,
      extra: { code: error instanceof Error ? error.message : 'MERGE_FAILED' },
    })
  }
})
