import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const knowledgeDocumentImages = pgTable(
  'knowledge_document_images',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    documentId: text('document_id').notNull(),
    anchorText: text('anchor_text').notNull(),
    sourceCharOffset: integer('source_char_offset'),
    sourceText: text('source_text'),
    mimeType: text('mime_type').notNull(),
    contentBase64: text('content_base64').notNull(),
    sortOrder: integer('sort_order').notNull(),
    boundChunkId: text('bound_chunk_id'),
    bindingStatus: text('binding_status').notNull().default('pending'),
    bindingError: text('binding_error'),
    bindingGeneration: integer('binding_generation').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('knowledge_document_images_document_idx').on(table.documentId),
    datasetIdx: index('knowledge_document_images_dataset_idx').on(table.datasetId),
    boundChunkIdx: index('knowledge_document_images_bound_chunk_idx').on(table.boundChunkId),
    pendingIdx: index('knowledge_document_images_pending_idx').on(
      table.bindingStatus,
      table.documentId
    ),
    documentOrderUnique: uniqueIndex('knowledge_document_images_document_order_unique').on(
      table.documentId,
      table.sortOrder
    ),
  })
)

export type KnowledgeDocumentImage = typeof knowledgeDocumentImages.$inferSelect
export type NewKnowledgeDocumentImage = typeof knowledgeDocumentImages.$inferInsert
