import type { KnowledgeBaseType } from '@crewmeld/db/schema'

export interface ChatKnowledgeBase {
  /** RAGFlow dataset ID used for retrieval. */
  id: string
  /** CrewMeld local knowledge-base ID used for management Top 3 queries. */
  knowledgeBaseId: string
  name: string
  type: KnowledgeBaseType
}

interface DatasetCandidate {
  id: string
  name: string
  type?: KnowledgeBaseType
  metadata?: { id?: string; enabled?: boolean } | null
}

/** Return enabled datasets in the employee binding order. */
export function filterEmployeeDatasets(
  boundIds: string[],
  datasets: DatasetCandidate[]
): ChatKnowledgeBase[] {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]))
  return boundIds.flatMap((id) => {
    const dataset = byId.get(id)
    if (!dataset || dataset.metadata?.enabled !== true || !dataset.metadata.id) return []
    return [
      {
        id: dataset.id,
        knowledgeBaseId: dataset.metadata.id,
        name: dataset.name,
        type: dataset.type ?? 'document',
      },
    ]
  })
}

/** Empty selection intentionally means all employee-bound datasets. */
export function normalizeKnowledgeSelection(ids: string[]): string[] | undefined {
  const unique = [...new Set(ids.filter(Boolean))]
  return unique.length > 0 ? unique : undefined
}
