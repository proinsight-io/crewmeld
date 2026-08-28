import { sql } from 'drizzle-orm'
import { boolean, check, doublePrecision, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export type KnowledgeBaseType = 'document' | 'qa'
export type KnowledgeBaseNavigation = Record<string, unknown>

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: text('id').primaryKey(),
    ragflowDatasetId: text('ragflow_dataset_id').notNull().unique(),
    type: text('type').$type<KnowledgeBaseType>().notNull().default('document'),
    thresholdOverride: doublePrecision('threshold_override'),
    enabled: boolean('enabled').notNull().default(true),
    navigation: jsonb('navigation').$type<KnowledgeBaseNavigation>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeCheck: check('knowledge_bases_type_check', sql`${table.type} IN ('document', 'qa')`),
    thresholdCheck: check(
      'knowledge_bases_threshold_override_check',
      sql`${table.thresholdOverride} IS NULL OR (${table.thresholdOverride} >= 0 AND ${table.thresholdOverride} <= 1)`
    ),
  })
)
