import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { user } from '../schema'
import { knowledgeBases } from './knowledge-bases'

export const qaRecordStatusEnum = pgEnum('qa_record_status', [
  'pending',
  'syncing',
  'active',
  'failed',
  'superseded',
])

export type QaRecordStatus = (typeof qaRecordStatusEnum.enumValues)[number]

export const qaCleanupStatusEnum = pgEnum('qa_cleanup_status', [
  'pending',
  'not_required',
  'complete',
  'failed',
])

function qaBatchIdColumn(): AnyPgColumn {
  return qaCsvBatches.id
}

function qaDocumentVersionIdColumn(): AnyPgColumn {
  return qaDocumentVersions.id
}

export const qaCsvBatches = pgTable(
  'qa_csv_batches',
  {
    id: text('id').primaryKey(),
    knowledgeBaseId: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    activeVersionId: text('active_version_id'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    knowledgeBaseIdx: index('qa_csv_batches_knowledge_base_idx').on(table.knowledgeBaseId),
    activeVersionFk: foreignKey({
      columns: [table.activeVersionId],
      foreignColumns: [qaDocumentVersionIdColumn()],
      name: 'qa_csv_batches_active_version_fk',
    }).onDelete('set null'),
  })
)

export const qaDocumentVersions = pgTable(
  'qa_document_versions',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull().references(qaBatchIdColumn, { onDelete: 'cascade' }),
    ragflowDocumentId: text('ragflow_document_id'),
    checksum: text('checksum').notNull(),
    filename: text('filename').notNull(),
    status: qaRecordStatusEnum('status').notNull().default('pending'),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    error: text('error'),
    cleanupStatus: qaCleanupStatusEnum('cleanup_status').notNull().default('pending'),
    cleanupError: text('cleanup_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchStatusIdx: index('qa_document_versions_batch_status_idx').on(table.batchId, table.status),
  })
)

export const qaQuestions = pgTable(
  'qa_questions',
  {
    id: text('id').primaryKey(),
    knowledgeBaseId: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    batchId: text('batch_id')
      .notNull()
      .references(() => qaCsvBatches.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    normalizedQuestion: text('normalized_question').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchIdx: index('qa_questions_batch_idx').on(table.batchId),
    enabledNormalizedUnique: uniqueIndex('qa_questions_enabled_normalized_uidx')
      .on(table.knowledgeBaseId, table.normalizedQuestion)
      .where(sql`${table.enabled} = true`),
  })
)

export const qaSyncJobs = pgTable(
  'qa_sync_jobs',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => qaCsvBatches.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    attempts: integer('attempts').notNull().default(0),
    status: qaRecordStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchStatusIdx: index('qa_sync_jobs_batch_status_idx').on(table.batchId, table.status),
  })
)
