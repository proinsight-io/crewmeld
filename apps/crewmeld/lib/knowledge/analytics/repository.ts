import {
  db,
  knowledgeBases,
  knowledgeQuestionGroups,
  knowledgeQuestionMergeOperations,
  knowledgeQuestionOccurrences,
} from '@crewmeld/db'
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { normalizeObservedQuestion } from './normalization'
import { boundTopN, type TopFrequentQuestion } from './top-questions'

export interface CaptureQuestionInput {
  employeeId: string
  conversationId: string
  messageId: string
  question: string
  requestedDatasetIds?: string[]
}

export interface FrequentQuestionListQuery {
  keyword?: string
  knowledgeBaseId?: string | 'other'
  status?: string
  page: number
  pageSize: number
  sort: 'count' | 'recent'
}

export interface TopFrequentQuestionOrder {
  field: 'occurrenceCount' | 'lastSeenAt' | 'id'
  direction: 'asc' | 'desc'
}

export interface TopFrequentQuestionsQuery {
  knowledgeBaseId: string
  excludedStatus: 'merged'
  orderBy: TopFrequentQuestionOrder[]
  limit: number
}

export interface TopFrequentQuestionsQueryAdapter {
  list(query: TopFrequentQuestionsQuery): Promise<TopFrequentQuestion[]>
}

interface TopFrequentQuestionsDatabaseRow {
  id: string
  knowledgeBaseId: string | null
  question: string
  occurrenceCount: number
  lastSeenAt: Date
  status: string
}

export interface TopFrequentQuestionsDatabase {
  select(selection: Record<string, unknown>): {
    from(table: unknown): {
      where(condition: unknown): {
        orderBy(...orderBy: unknown[]): {
          limit(limit: number): Promise<TopFrequentQuestionsDatabaseRow[]>
        }
      }
    }
  }
}

async function resolveSingleKnowledgeBaseId(datasetIds?: string[]): Promise<string | null> {
  const unique = [...new Set(datasetIds ?? [])]
  if (unique.length !== 1) return null
  const [row] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.ragflowDatasetId, unique[0]), eq(knowledgeBases.enabled, true)))
    .limit(1)
  return row?.id ?? null
}

/** Capture one immutable occurrence and update its deterministic aggregate. */
export async function captureQuestionOccurrence(
  input: CaptureQuestionInput
): Promise<string | null> {
  const question = input.question.trim()
  const normalizedQuestion = normalizeObservedQuestion(question)
  if (!normalizedQuestion) return null
  const knowledgeBaseId = await resolveSingleKnowledgeBaseId(input.requestedDatasetIds)
  return db.transaction(async (tx) => {
    const [duplicate] = await tx
      .select({ groupId: knowledgeQuestionOccurrences.groupId })
      .from(knowledgeQuestionOccurrences)
      .where(eq(knowledgeQuestionOccurrences.messageId, input.messageId))
      .limit(1)
    if (duplicate) return duplicate.groupId

    const scopeCondition = knowledgeBaseId
      ? eq(knowledgeQuestionGroups.knowledgeBaseId, knowledgeBaseId)
      : isNull(knowledgeQuestionGroups.knowledgeBaseId)
    const [existing] = await tx
      .select({ id: knowledgeQuestionGroups.id })
      .from(knowledgeQuestionGroups)
      .where(
        and(
          eq(knowledgeQuestionGroups.employeeId, input.employeeId),
          scopeCondition,
          eq(knowledgeQuestionGroups.normalizedQuestion, normalizedQuestion),
          ne(knowledgeQuestionGroups.status, 'merged')
        )
      )
      .limit(1)
    const groupId = existing?.id ?? crypto.randomUUID()
    const now = new Date()
    if (existing) {
      await tx
        .update(knowledgeQuestionGroups)
        .set({
          occurrenceCount: sql`${knowledgeQuestionGroups.occurrenceCount} + 1`,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(knowledgeQuestionGroups.id, groupId))
    } else {
      await tx.insert(knowledgeQuestionGroups).values({
        id: groupId,
        employeeId: input.employeeId,
        knowledgeBaseId,
        canonicalQuestion: question,
        normalizedQuestion,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
    }
    await tx.insert(knowledgeQuestionOccurrences).values({
      id: crypto.randomUUID(),
      groupId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      originalQuestion: question,
      createdAt: now,
    })
    return groupId
  })
}

export async function listFrequentQuestions(query: FrequentQuestionListQuery) {
  const conditions = [ne(knowledgeQuestionGroups.status, 'merged')]
  if (query.keyword) {
    conditions.push(
      or(
        ilike(knowledgeQuestionGroups.canonicalQuestion, `%${query.keyword}%`),
        ilike(knowledgeQuestionGroups.answer, `%${query.keyword}%`)
      )!
    )
  }
  if (query.knowledgeBaseId === 'other')
    conditions.push(isNull(knowledgeQuestionGroups.knowledgeBaseId))
  else if (query.knowledgeBaseId)
    conditions.push(eq(knowledgeQuestionGroups.knowledgeBaseId, query.knowledgeBaseId))
  if (query.status) conditions.push(eq(knowledgeQuestionGroups.status, query.status))
  const where = and(...conditions)
  const order =
    query.sort === 'recent'
      ? [desc(knowledgeQuestionGroups.lastSeenAt), desc(knowledgeQuestionGroups.occurrenceCount)]
      : [desc(knowledgeQuestionGroups.occurrenceCount), desc(knowledgeQuestionGroups.lastSeenAt)]
  const rows = await db
    .select()
    .from(knowledgeQuestionGroups)
    .where(where)
    .orderBy(...order)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
  const [total] = await db.select({ value: count() }).from(knowledgeQuestionGroups).where(where)
  return { rows, total: total?.value ?? 0 }
}

export function createListTopFrequentQuestions(queryAdapter: TopFrequentQuestionsQueryAdapter) {
  return (knowledgeBaseId: string, limit = 3): Promise<TopFrequentQuestion[]> =>
    queryAdapter.list({
      knowledgeBaseId,
      excludedStatus: 'merged',
      orderBy: [
        { field: 'occurrenceCount', direction: 'desc' },
        { field: 'lastSeenAt', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      limit: boundTopN(limit),
    })
}

function topFrequentQuestionOrderBy(query: TopFrequentQuestionsQuery): unknown[] {
  return query.orderBy.map(({ field, direction }) => {
    const column = knowledgeQuestionGroups[field]
    return direction === 'asc' ? asc(column) : desc(column)
  })
}

export function createDatabaseTopFrequentQuestionsQueryAdapter(
  database: TopFrequentQuestionsDatabase
): TopFrequentQuestionsQueryAdapter {
  return {
    async list(query) {
      const rows = await database
        .select({
          id: knowledgeQuestionGroups.id,
          knowledgeBaseId: knowledgeQuestionGroups.knowledgeBaseId,
          question: knowledgeQuestionGroups.canonicalQuestion,
          occurrenceCount: knowledgeQuestionGroups.occurrenceCount,
          lastSeenAt: knowledgeQuestionGroups.lastSeenAt,
          status: knowledgeQuestionGroups.status,
        })
        .from(knowledgeQuestionGroups)
        .where(
          and(
            eq(knowledgeQuestionGroups.knowledgeBaseId, query.knowledgeBaseId),
            ne(knowledgeQuestionGroups.status, query.excludedStatus)
          )
        )
        .orderBy(...topFrequentQuestionOrderBy(query))
        .limit(query.limit)

      return rows.map((row) => ({ ...row, knowledgeBaseId: row.knowledgeBaseId! }))
    },
  }
}

const databaseTopFrequentQuestionsQueryAdapter = createDatabaseTopFrequentQuestionsQueryAdapter(
  db as unknown as TopFrequentQuestionsDatabase
)

export function listTopFrequentQuestions(
  knowledgeBaseId: string,
  limit = 3,
  queryAdapter: TopFrequentQuestionsQueryAdapter = databaseTopFrequentQuestionsQueryAdapter
): Promise<TopFrequentQuestion[]> {
  return createListTopFrequentQuestions(queryAdapter)(knowledgeBaseId, limit)
}

export async function classifyQuestionGroups(ids: string[], knowledgeBaseId: string | null) {
  if (knowledgeBaseId) {
    const [knowledgeBase] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, knowledgeBaseId))
      .limit(1)
    if (!knowledgeBase) throw new Error('KNOWLEDGE_BASE_NOT_FOUND')
  }
  return db
    .update(knowledgeQuestionGroups)
    .set({ knowledgeBaseId, updatedAt: new Date() })
    .where(
      and(inArray(knowledgeQuestionGroups.id, ids), ne(knowledgeQuestionGroups.status, 'merged'))
    )
    .returning({ id: knowledgeQuestionGroups.id })
}

export async function mergeQuestionGroups(
  ids: string[],
  canonicalQuestion: string | undefined,
  actorId: string
) {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length < 2) throw new Error('MERGE_REQUIRES_MULTIPLE_GROUPS')
  return db.transaction(async (tx) => {
    const groups = await tx
      .select()
      .from(knowledgeQuestionGroups)
      .where(
        and(
          inArray(knowledgeQuestionGroups.id, uniqueIds),
          ne(knowledgeQuestionGroups.status, 'merged')
        )
      )
    if (groups.length !== uniqueIds.length) throw new Error('QUESTION_GROUP_NOT_FOUND')
    const target = groups.find((group) => group.id === uniqueIds[0])!
    const sources = groups.filter((group) => group.id !== target.id)
    const sourceIds = sources.map((group) => group.id)
    const occurrences = sourceIds.length
      ? await tx
          .select({
            id: knowledgeQuestionOccurrences.id,
            groupId: knowledgeQuestionOccurrences.groupId,
          })
          .from(knowledgeQuestionOccurrences)
          .where(inArray(knowledgeQuestionOccurrences.groupId, sourceIds))
      : []
    const snapshot = {
      target,
      sources: sources.map((source) => ({
        ...source,
        occurrenceIds: occurrences
          .filter((occurrence) => occurrence.groupId === source.id)
          .map((occurrence) => occurrence.id),
      })),
    }
    const mergedQuestion = canonicalQuestion?.trim() || target.canonicalQuestion
    await tx
      .update(knowledgeQuestionGroups)
      .set({
        canonicalQuestion: mergedQuestion,
        normalizedQuestion: normalizeObservedQuestion(mergedQuestion),
        occurrenceCount: groups.reduce((sum, group) => sum + group.occurrenceCount, 0),
        lastSeenAt: new Date(Math.max(...groups.map((group) => group.lastSeenAt.getTime()))),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeQuestionGroups.id, target.id))
    if (sourceIds.length) {
      await tx
        .update(knowledgeQuestionOccurrences)
        .set({ groupId: target.id })
        .where(inArray(knowledgeQuestionOccurrences.groupId, sourceIds))
      await tx
        .update(knowledgeQuestionGroups)
        .set({ status: 'merged', mergedIntoId: target.id, updatedAt: new Date() })
        .where(inArray(knowledgeQuestionGroups.id, sourceIds))
    }
    const operationId = crypto.randomUUID()
    await tx.insert(knowledgeQuestionMergeOperations).values({
      id: operationId,
      targetGroupId: target.id,
      snapshot,
      createdBy: actorId,
    })
    return { operationId, targetGroupId: target.id }
  })
}

export async function unmergeQuestionGroups(operationId: string, actorId: string) {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(knowledgeQuestionMergeOperations)
      .where(
        and(
          eq(knowledgeQuestionMergeOperations.id, operationId),
          isNull(knowledgeQuestionMergeOperations.revertedAt)
        )
      )
      .limit(1)
    if (!operation) throw new Error('MERGE_OPERATION_NOT_FOUND')
    const target = operation.snapshot.target
    await tx
      .update(knowledgeQuestionGroups)
      .set({
        canonicalQuestion: String(target.canonicalQuestion),
        normalizedQuestion: String(target.normalizedQuestion),
        occurrenceCount: Number(target.occurrenceCount),
        status: String(target.status),
        mergedIntoId: (target.mergedIntoId as string | null) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeQuestionGroups.id, operation.targetGroupId))
    for (const source of operation.snapshot.sources) {
      const sourceId = String(source.id)
      await tx
        .update(knowledgeQuestionGroups)
        .set({
          status: String(source.status),
          mergedIntoId: (source.mergedIntoId as string | null) ?? null,
          occurrenceCount: Number(source.occurrenceCount),
          updatedAt: new Date(),
        })
        .where(eq(knowledgeQuestionGroups.id, sourceId))
      if (source.occurrenceIds.length) {
        await tx
          .update(knowledgeQuestionOccurrences)
          .set({ groupId: sourceId })
          .where(inArray(knowledgeQuestionOccurrences.id, source.occurrenceIds))
      }
    }
    await tx
      .update(knowledgeQuestionMergeOperations)
      .set({ revertedAt: new Date(), revertedBy: actorId })
      .where(eq(knowledgeQuestionMergeOperations.id, operationId))
    return { targetGroupId: operation.targetGroupId }
  })
}

export async function markQuestionGroupPromoted(
  groupId: string,
  question: string,
  answer: string,
  qaQuestionId: string
) {
  const [row] = await db
    .update(knowledgeQuestionGroups)
    .set({
      canonicalQuestion: question,
      normalizedQuestion: normalizeObservedQuestion(question),
      answer,
      promotedQaQuestionId: qaQuestionId,
      status: 'promoted',
      updatedAt: new Date(),
    })
    .where(
      and(eq(knowledgeQuestionGroups.id, groupId), ne(knowledgeQuestionGroups.status, 'merged'))
    )
    .returning()
  return row ?? null
}
