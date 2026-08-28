import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { classifyQuestionGroups } from '@/lib/knowledge/analytics/repository'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'

const Body = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  knowledgeBaseId: z.string().min(1).nullable(),
})

export const POST = withAudit(async (request: Request) => {
  const auth = await requirePermission(QA_PERMISSIONS.edit)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return apiErr('api.common.invalidParams', { status: 400 })
  try {
    const rows = await classifyQuestionGroups(parsed.data.ids, parsed.data.knowledgeBaseId)
    return apiOk({ updated: rows.length })
  } catch (error) {
    return apiErr('api.common.invalidParams', {
      status: 400,
      extra: { code: error instanceof Error ? error.message : 'CLASSIFY_FAILED' },
    })
  }
})
