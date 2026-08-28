import {
  type AnyPgColumn,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { user } from '../schema'
import { conversations } from './conversations'
import { digitalEmployees } from './employee'
import { knowledgeBases } from './knowledge-bases'
import { qaQuestions } from './knowledge-questions'

function groupIdColumn(): AnyPgColumn {
  return knowledgeQuestionGroups.id
}

export const knowledgeQuestionGroups = pgTable(
  'knowledge_question_groups',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id')
      .notNull()
      .references(() => digitalEmployees.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, {
      onDelete: 'set null',
    }),
    canonicalQuestion: text('canonical_question').notNull(),
    normalizedQuestion: text('normalized_question').notNull(),
    answer: text('answer'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    status: text('status').notNull().default('open'),
    mergedIntoId: text('merged_into_id').references(groupIdColumn, { onDelete: 'set null' }),
    promotedQaQuestionId: text('promoted_qa_question_id').references(() => qaQuestions.id, {
      onDelete: 'set null',
    }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    employeeStatusIdx: index('knowledge_question_groups_employee_status_idx').on(
      table.employeeId,
      table.status
    ),
    knowledgeBaseIdx: index('knowledge_question_groups_knowledge_base_idx').on(
      table.knowledgeBaseId
    ),
    popularityIdx: index('knowledge_question_groups_popularity_idx').on(
      table.occurrenceCount,
      table.lastSeenAt
    ),
  })
)

export const knowledgeQuestionOccurrences = pgTable(
  'knowledge_question_occurrences',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => knowledgeQuestionGroups.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull().unique(),
    originalQuestion: text('original_question').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    groupIdx: index('knowledge_question_occurrences_group_idx').on(table.groupId),
    createdAtIdx: index('knowledge_question_occurrences_created_at_idx').on(table.createdAt),
  })
)

export interface KnowledgeQuestionMergeSnapshot {
  target: Record<string, unknown>
  sources: Array<Record<string, unknown> & { occurrenceIds: string[] }>
}

export const knowledgeQuestionMergeOperations = pgTable(
  'knowledge_question_merge_operations',
  {
    id: text('id').primaryKey(),
    targetGroupId: text('target_group_id')
      .notNull()
      .references(() => knowledgeQuestionGroups.id, { onDelete: 'cascade' }),
    snapshot: jsonb('snapshot').$type<KnowledgeQuestionMergeSnapshot>().notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: text('reverted_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetIdx: index('knowledge_question_merge_operations_target_idx').on(table.targetGroupId),
  })
)

export type KnowledgeUnansweredReason = 'no_chunks' | 'low_similarity' | 'model_declined'
export type KnowledgeUnansweredStatus =
  | 'pending'
  | 'syncing'
  | 'resolved'
  | 'ignored'
  | 'sync_failed'

export const knowledgeUnansweredQuestions = pgTable(
  'knowledge_unanswered_questions',
  {
    id: text('id').primaryKey(),
    questionGroupId: text('question_group_id')
      .notNull()
      .unique()
      .references(() => knowledgeQuestionGroups.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, {
      onDelete: 'set null',
    }),
    question: text('question').notNull(),
    normalizedQuestion: text('normalized_question').notNull(),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    maxSimilarity: doublePrecision('max_similarity'),
    reason: text('reason').notNull().$type<KnowledgeUnansweredReason>(),
    status: text('status').notNull().default('pending').$type<KnowledgeUnansweredStatus>(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedQaQuestionId: text('resolved_qa_question_id').references(() => qaQuestions.id, {
      onDelete: 'set null',
    }),
    syncError: text('sync_error'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('knowledge_unanswered_questions_status_idx').on(table.status),
    knowledgeBaseIdx: index('knowledge_unanswered_questions_knowledge_base_idx').on(
      table.knowledgeBaseId
    ),
    occurrenceCountIdx: index('knowledge_unanswered_questions_occurrence_count_idx').on(
      table.occurrenceCount,
      table.lastSeenAt
    ),
  })
)
