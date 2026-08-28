import type { QaQuestionRecord } from './types'

export interface QaPopularitySource {
  counts(knowledgeBaseId: string, questionIds: string[], since: Date): Promise<Map<string, number>>
}
export interface QaQuestionSource {
  exportRows(knowledgeBaseId: string, enabled?: boolean): Promise<QaQuestionRecord[]>
}
const zeroPopularity: QaPopularitySource = {
  async counts() {
    return new Map()
  },
}

export async function listTopKnowledgeQuestions(
  knowledgeBaseId: string,
  limit = 3,
  popularity: QaPopularitySource = zeroPopularity,
  source?: QaQuestionSource
): Promise<QaQuestionRecord[]> {
  const bounded = Math.min(50, Math.max(1, Math.trunc(limit) || 1))
  const questionSource = source ?? (await import('./repository')).qaQuestionRepository
  const rows = await questionSource.exportRows(knowledgeBaseId, true)
  const counts = await popularity.counts(
    knowledgeBaseId,
    rows.map((row) => row.id),
    new Date(Date.now() - 30 * 86_400_000)
  )
  return rows
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, bounded)
}
