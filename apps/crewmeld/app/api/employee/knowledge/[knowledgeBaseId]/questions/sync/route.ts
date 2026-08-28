import type { NextRequest } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@crewmeld/db'
import { qaCsvBatches, qaQuestions } from '@crewmeld/db/schema'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'
import { assertQaKnowledgeBase, QaServiceError } from '@/lib/knowledge/qa/service'
import { enqueueQaBatchSync } from '@/lib/knowledge/qa/sync-service'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const auth = await requirePermission(QA_PERMISSIONS.edit)
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { knowledgeBaseId } = await params
  try {
    await assertQaKnowledgeBase((await import('@/lib/knowledge/qa/repository')).qaQuestionRepository, knowledgeBaseId)
    const batches = await db.selectDistinct({ id: qaCsvBatches.id }).from(qaCsvBatches)
      .innerJoin(qaQuestions, eq(qaQuestions.batchId, qaCsvBatches.id))
      .where(and(eq(qaCsvBatches.knowledgeBaseId, knowledgeBaseId), isNull(qaCsvBatches.activeVersionId)))
    const jobs = await Promise.all(batches.map((batch) => enqueueQaBatchSync(batch.id, 'manual')))
    return apiOk({ submitted: jobs.length })
  } catch (error) {
    if (error instanceof QaServiceError) return apiErr('api.common.invalidParams', { status: error.status, extra: { code: error.code } })
    return apiErr('api.common.internalError', { status: 500 })
  }
}
