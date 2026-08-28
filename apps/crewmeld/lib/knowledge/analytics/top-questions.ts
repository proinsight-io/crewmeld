export interface TopFrequentQuestion {
  id: string
  knowledgeBaseId: string
  question: string
  occurrenceCount: number
  lastSeenAt: Date
  status: string
}

export function boundTopN(value = 3): number {
  return Math.min(100, Math.max(1, Math.trunc(value) || 3))
}

export function rankTopFrequentQuestions(rows: TopFrequentQuestion[], limit = 3) {
  return rows
    .filter((row) => row.status !== 'merged')
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount ||
        b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
        a.id.localeCompare(b.id)
    )
    .slice(0, boundTopN(limit))
}
