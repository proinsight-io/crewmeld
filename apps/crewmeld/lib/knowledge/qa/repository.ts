import { db } from '@crewmeld/db'
import { knowledgeBases, qaCsvBatches, qaDocumentVersions, qaQuestions } from '@crewmeld/db/schema'
import { and, asc, count, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import { readQaSnapshotPages, runQaTransaction } from './repository-core'
import { QaServiceError } from './service'
import type { QaListQuery, QaQuestionRepository } from './types'

const selection = {
  id: qaQuestions.id,
  knowledgeBaseId: qaQuestions.knowledgeBaseId,
  question: qaQuestions.question,
  answer: qaQuestions.answer,
  enabled: qaQuestions.enabled,
  sortOrder: qaQuestions.sortOrder,
  tags: qaQuestions.tags,
  version: qaQuestions.version,
  createdBy: qaQuestions.createdBy,
  updatedBy: qaQuestions.updatedBy,
  syncStatus: qaDocumentVersions.status,
  filename: qaDocumentVersions.filename,
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function createQaQuestionRepository(database: typeof db): QaQuestionRepository {
  return {
    async findBatchId(id, knowledgeBaseId) {
      const [row] = await database
        .select({ batchId: qaQuestions.batchId })
        .from(qaQuestions)
        .where(and(eq(qaQuestions.id, id), eq(qaQuestions.knowledgeBaseId, knowledgeBaseId)))
        .limit(1)
      return row?.batchId ?? null
    },
    async isQaKnowledgeBase(id) {
      const [row] = await database
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.type, 'qa')))
        .limit(1)
      return Boolean(row)
    },
    async list(knowledgeBaseId, query: QaListQuery) {
      const conditions = [eq(qaQuestions.knowledgeBaseId, knowledgeBaseId)]
      if (query.keyword)
        conditions.push(
          or(
            ilike(qaQuestions.question, `%${query.keyword}%`),
            ilike(qaQuestions.answer, `%${query.keyword}%`)
          )!
        )
      if (query.enabled !== undefined) conditions.push(eq(qaQuestions.enabled, query.enabled))
      if (query.tag)
        conditions.push(sql`${qaQuestions.tags} @> ${JSON.stringify([query.tag])}::jsonb`)
      if (query.syncStatus) conditions.push(eq(qaDocumentVersions.status, query.syncStatus))
      if (query.filename) conditions.push(ilike(qaDocumentVersions.filename, `%${query.filename}%`))
      const where = and(...conditions)
      const base = database
        .select(selection)
        .from(qaQuestions)
        .leftJoin(qaCsvBatches, eq(qaQuestions.batchId, qaCsvBatches.id))
        .leftJoin(qaDocumentVersions, eq(qaCsvBatches.activeVersionId, qaDocumentVersions.id))
      const rows = await base
        .where(where)
        .orderBy(asc(qaQuestions.sortOrder), asc(qaQuestions.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
      const [total] = await database
        .select({ value: count() })
        .from(qaQuestions)
        .leftJoin(qaCsvBatches, eq(qaQuestions.batchId, qaCsvBatches.id))
        .leftJoin(qaDocumentVersions, eq(qaCsvBatches.activeVersionId, qaDocumentVersions.id))
        .where(where)
      return { rows, total: total?.value ?? 0 }
    },
    async create(knowledgeBaseId, input, actorId) {
      return runQaTransaction(database, async (tx) => {
        if (input.enabled) {
          const conflict = await tx
            .select({ id: qaQuestions.id })
            .from(qaQuestions)
            .where(
              and(
                eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
                eq(qaQuestions.enabled, true),
                eq(qaQuestions.normalizedQuestion, normalized(input.question))
              )
            )
            .limit(1)
          if (conflict.length)
            throw new QaServiceError('QA_DUPLICATE_QUESTION', 409, { conflicts: conflict })
        }
        const batchId = crypto.randomUUID()
        await tx.insert(qaCsvBatches).values({ id: batchId, knowledgeBaseId, createdBy: actorId })
        const [row] = await tx
          .insert(qaQuestions)
          .values({
            id: crypto.randomUUID(),
            batchId,
            knowledgeBaseId,
            ...input,
            normalizedQuestion: normalized(input.question),
            createdBy: actorId,
            updatedBy: actorId,
          })
          .returning()
        if (!row) throw new Error('QA question insert returned no row')
        return { ...row, syncStatus: null }
      })
    },
    async update(id, knowledgeBaseId, input, version, actorId) {
      return runQaTransaction(database, async (tx) => {
        const [existing] = await tx
          .select({ question: qaQuestions.question, enabled: qaQuestions.enabled })
          .from(qaQuestions)
          .where(
            and(
              eq(qaQuestions.id, id),
              eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
              eq(qaQuestions.version, version)
            )
          )
          .limit(1)
        if (!existing) return null
        const nextQuestion = input.question ?? existing.question
        const nextEnabled = input.enabled ?? existing.enabled
        if (nextEnabled) {
          const conflicts = await tx
            .select({ id: qaQuestions.id, normalizedQuestion: qaQuestions.normalizedQuestion })
            .from(qaQuestions)
            .where(
              and(
                eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
                eq(qaQuestions.enabled, true),
                eq(qaQuestions.normalizedQuestion, normalized(nextQuestion)),
                ne(qaQuestions.id, id)
              )
            )
          if (conflicts.length)
            throw new QaServiceError('QA_DUPLICATE_QUESTION', 409, { conflicts })
        }
        const values = {
          ...input,
          ...(input.question ? { normalizedQuestion: normalized(input.question) } : {}),
          updatedBy: actorId,
          updatedAt: new Date(),
          version: version + 1,
        }
        const [row] = await tx
          .update(qaQuestions)
          .set(values)
          .where(
            and(
              eq(qaQuestions.id, id),
              eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
              eq(qaQuestions.version, version)
            )
          )
          .returning()
        return row ? { ...row, syncStatus: null } : null
      })
    },
    async remove(id, knowledgeBaseId) {
      const rows = await database
        .delete(qaQuestions)
        .where(and(eq(qaQuestions.id, id), eq(qaQuestions.knowledgeBaseId, knowledgeBaseId)))
        .returning({ id: qaQuestions.id })
      return rows.length > 0
    },
    async findEnabledNormalized(knowledgeBaseId, values, excludeId) {
      if (!values.length) return []
      return database
        .select({ id: qaQuestions.id, normalizedQuestion: qaQuestions.normalizedQuestion })
        .from(qaQuestions)
        .where(
          and(
            eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
            eq(qaQuestions.enabled, true),
            inArray(qaQuestions.normalizedQuestion, values),
            excludeId ? ne(qaQuestions.id, excludeId) : undefined
          )
        )
    },
    async importBatch(knowledgeBaseId, rows, checksum, filename, actorId) {
      return runQaTransaction(database, async (tx) => {
        const normalizedRows = rows
          .filter((row) => row.enabled)
          .map((row) => normalized(row.question))
        if (normalizedRows.length) {
          const conflicts = await tx
            .select({ id: qaQuestions.id, normalizedQuestion: qaQuestions.normalizedQuestion })
            .from(qaQuestions)
            .where(
              and(
                eq(qaQuestions.knowledgeBaseId, knowledgeBaseId),
                eq(qaQuestions.enabled, true),
                inArray(qaQuestions.normalizedQuestion, normalizedRows)
              )
            )
          if (conflicts.length)
            throw new QaServiceError('QA_DUPLICATE_QUESTION', 409, { conflicts })
        }
        const batchId = crypto.randomUUID()
        const versionId = crypto.randomUUID()
        await tx
          .insert(qaCsvBatches)
          .values({ id: batchId, knowledgeBaseId, activeVersionId: null, createdBy: actorId })
        await tx
          .insert(qaDocumentVersions)
          .values({ id: versionId, batchId, checksum, filename, status: 'pending' })
        if (rows.length)
          await tx.insert(qaQuestions).values(
            rows.map((row) => ({
              id: crypto.randomUUID(),
              batchId,
              knowledgeBaseId,
              ...row,
              normalizedQuestion: normalized(row.question),
              createdBy: actorId,
              updatedBy: actorId,
            }))
          )
        return { batchId, count: rows.length }
      })
    },
    async exportRows(knowledgeBaseId, enabled) {
      const where =
        enabled === undefined
          ? eq(qaQuestions.knowledgeBaseId, knowledgeBaseId)
          : and(eq(qaQuestions.knowledgeBaseId, knowledgeBaseId), eq(qaQuestions.enabled, enabled))
      return database
        .select(selection)
        .from(qaQuestions)
        .leftJoin(qaCsvBatches, eq(qaQuestions.batchId, qaCsvBatches.id))
        .leftJoin(qaDocumentVersions, eq(qaCsvBatches.activeVersionId, qaDocumentVersions.id))
        .where(where)
        .orderBy(asc(qaQuestions.sortOrder), asc(qaQuestions.id))
    },
    async *exportPages(knowledgeBaseId, enabled, pageSize = 500) {
      const conditions = [eq(qaQuestions.knowledgeBaseId, knowledgeBaseId)]
      if (enabled !== undefined) conditions.push(eq(qaQuestions.enabled, enabled))
      const snapshot = await database
        .select({ id: qaQuestions.id })
        .from(qaQuestions)
        .where(and(...conditions))
        .orderBy(asc(qaQuestions.sortOrder), asc(qaQuestions.id))
      const ids = snapshot.map((row) => row.id)
      yield* readQaSnapshotPages(ids, pageSize, (chunk) =>
        database
          .select(selection)
          .from(qaQuestions)
          .leftJoin(qaCsvBatches, eq(qaQuestions.batchId, qaCsvBatches.id))
          .leftJoin(qaDocumentVersions, eq(qaCsvBatches.activeVersionId, qaDocumentVersions.id))
          .where(
            and(eq(qaQuestions.knowledgeBaseId, knowledgeBaseId), inArray(qaQuestions.id, chunk))
          )
      )
    },
  }
}

export const qaQuestionRepository = createQaQuestionRepository(db)
