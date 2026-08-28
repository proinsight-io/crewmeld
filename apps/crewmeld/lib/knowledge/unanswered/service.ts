import {
  db,
  knowledgeQuestionGroups,
  knowledgeQuestionOccurrences,
  knowledgeUnansweredQuestions,
} from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { normalizeObservedQuestion } from '@/lib/knowledge/analytics/normalization'

const logger = createLogger('UnansweredQuestions')

export type UnansweredReason = 'no_chunks' | 'low_similarity' | 'model_declined'

/** Detect explicit model statements that it cannot answer from available knowledge. */
export function isModelDeclinedAnswer(value: string | null): boolean {
  if (!value) return false
  return /(无法(?:为您|给您|提供|回答)|没有(?:查询|实时|相关|可用).{0,12}(?:功能|信息|能力)|cannot\s+(?:answer|provide)|don't\s+have.{0,20}(?:information|access))/i.test(value)
}

export interface RecordUnansweredQuestionInput {
  employeeId: string
  conversationId: string
  messageId: string
  question: string
  knowledgeBaseId: string | null
  maxSimilarity: number | null
  reason: UnansweredReason
}

export async function recordUnansweredQuestion(input: RecordUnansweredQuestionInput): Promise<void> {
  const question = input.question.trim()
  const normalizedQuestion = normalizeObservedQuestion(question)
  if (!normalizedQuestion) return
  await db.transaction(async (tx) => {
    const [existingOccurrence] = await tx
      .select({ groupId: knowledgeQuestionOccurrences.groupId })
      .from(knowledgeQuestionOccurrences)
      .where(eq(knowledgeQuestionOccurrences.messageId, input.messageId))
      .limit(1)
    if (existingOccurrence) {
      const now = new Date()
      await tx.insert(knowledgeUnansweredQuestions).values({ id: crypto.randomUUID(), questionGroupId: existingOccurrence.groupId, knowledgeBaseId: input.knowledgeBaseId, question, normalizedQuestion, conversationId: input.conversationId, maxSimilarity: input.maxSimilarity, reason: input.reason, occurrenceCount: 1, firstSeenAt: now, lastSeenAt: now }).onConflictDoUpdate({ target: knowledgeUnansweredQuestions.questionGroupId, set: { occurrenceCount: sql`${knowledgeUnansweredQuestions.occurrenceCount} + 1`, lastSeenAt: now, updatedAt: now, conversationId: input.conversationId, maxSimilarity: input.maxSimilarity, reason: input.reason } })
      return
    }
    const baseCondition = input.knowledgeBaseId
      ? eq(knowledgeQuestionGroups.knowledgeBaseId, input.knowledgeBaseId)
      : isNull(knowledgeQuestionGroups.knowledgeBaseId)
    const [existing] = await tx
      .select({ id: knowledgeQuestionGroups.id })
      .from(knowledgeQuestionGroups)
      .where(and(eq(knowledgeQuestionGroups.employeeId, input.employeeId), baseCondition, eq(knowledgeQuestionGroups.normalizedQuestion, normalizedQuestion)))
      .limit(1)
    const now = new Date()
    const groupId = existing?.id ?? crypto.randomUUID()
    if (existing) {
      await tx.update(knowledgeQuestionGroups).set({ occurrenceCount: sql`${knowledgeQuestionGroups.occurrenceCount} + 1`, lastSeenAt: now, updatedAt: now }).where(eq(knowledgeQuestionGroups.id, groupId))
    } else {
      await tx.insert(knowledgeQuestionGroups).values({ id: groupId, employeeId: input.employeeId, knowledgeBaseId: input.knowledgeBaseId, canonicalQuestion: question, normalizedQuestion, occurrenceCount: 1, firstSeenAt: now, lastSeenAt: now })
    }
    await tx.insert(knowledgeQuestionOccurrences).values({ id: crypto.randomUUID(), groupId, conversationId: input.conversationId, messageId: input.messageId, originalQuestion: question, createdAt: now })
    await tx.insert(knowledgeUnansweredQuestions).values({ id: crypto.randomUUID(), questionGroupId: groupId, knowledgeBaseId: input.knowledgeBaseId, question, normalizedQuestion, conversationId: input.conversationId, maxSimilarity: input.maxSimilarity, reason: input.reason, occurrenceCount: 1, firstSeenAt: now, lastSeenAt: now }).onConflictDoUpdate({ target: knowledgeUnansweredQuestions.questionGroupId, set: { occurrenceCount: sql`${knowledgeUnansweredQuestions.occurrenceCount} + 1`, lastSeenAt: now, updatedAt: now, conversationId: input.conversationId, maxSimilarity: input.maxSimilarity, reason: input.reason } })
  })
}

export function recordUnansweredQuestionSafely(input: RecordUnansweredQuestionInput): Promise<void> {
  return recordUnansweredQuestion(input).catch((error) => {
    logger.warn('Unanswered question capture failed', { employeeId: input.employeeId, error: error instanceof Error ? error.message : String(error) })
  })
}

export async function listUnansweredQuestions(employeeId: string, page: number, pageSize: number) {
  const where = eq(knowledgeQuestionGroups.employeeId, employeeId)
  const rows = await db.select({ id: knowledgeUnansweredQuestions.id, question: knowledgeUnansweredQuestions.question, occurrenceCount: knowledgeUnansweredQuestions.occurrenceCount, reason: knowledgeUnansweredQuestions.reason, lastSeenAt: knowledgeUnansweredQuestions.lastSeenAt }).from(knowledgeUnansweredQuestions).innerJoin(knowledgeQuestionGroups, eq(knowledgeUnansweredQuestions.questionGroupId, knowledgeQuestionGroups.id)).where(where).orderBy(desc(knowledgeUnansweredQuestions.occurrenceCount), desc(knowledgeUnansweredQuestions.lastSeenAt)).limit(pageSize).offset((page - 1) * pageSize)
  const [total] = await db.select({ value: count() }).from(knowledgeUnansweredQuestions).innerJoin(knowledgeQuestionGroups, eq(knowledgeUnansweredQuestions.questionGroupId, knowledgeQuestionGroups.id)).where(where)
  return { rows, total: total?.value ?? 0 }
}
