import type { QaRecordStatus } from '@crewmeld/db/schema'

export interface QaQuestionRecord {
  id: string
  knowledgeBaseId: string
  question: string
  answer: string
  enabled: boolean
  sortOrder: number
  tags: string[]
  version: number
  createdBy: string | null
  updatedBy: string | null
  syncStatus: QaRecordStatus | null
  filename?: string | null
}

export interface QaQuestionInput {
  question: string
  answer: string
  enabled: boolean
  sortOrder: number
  tags: string[]
}

export interface QaListQuery {
  keyword?: string
  enabled?: boolean
  tag?: string
  syncStatus?: QaRecordStatus
  filename?: string
  page: number
  pageSize: number
}

export interface QaQuestionRepository {
  findBatchId(id: string, knowledgeBaseId: string): Promise<string | null>
  isQaKnowledgeBase(knowledgeBaseId: string): Promise<boolean>
  list(
    knowledgeBaseId: string,
    query: QaListQuery
  ): Promise<{ rows: QaQuestionRecord[]; total: number }>
  create(
    knowledgeBaseId: string,
    input: QaQuestionInput,
    actorId: string
  ): Promise<QaQuestionRecord>
  update(
    id: string,
    knowledgeBaseId: string,
    input: Partial<QaQuestionInput>,
    version: number,
    actorId: string
  ): Promise<QaQuestionRecord | null>
  remove(id: string, knowledgeBaseId: string): Promise<boolean>
  findEnabledNormalized(
    knowledgeBaseId: string,
    normalized: string[],
    excludeId?: string
  ): Promise<Array<{ id: string; normalizedQuestion: string }>>
  importBatch(
    knowledgeBaseId: string,
    rows: QaQuestionInput[],
    checksum: string,
    filename: string,
    actorId: string
  ): Promise<{ batchId: string; count: number }>
  exportRows(knowledgeBaseId: string, enabled?: boolean): Promise<QaQuestionRecord[]>
  exportPages(
    knowledgeBaseId: string,
    enabled?: boolean,
    pageSize?: number
  ): AsyncIterable<QaQuestionRecord[]>
}
