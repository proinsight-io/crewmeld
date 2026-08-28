import { db } from '@crewmeld/db'
import { knowledgeBases } from '@crewmeld/db/schema'
import { eq, inArray } from 'drizzle-orm'
import {
  createKnowledgeMetadataRepository,
  type KnowledgeMetadataAdapter,
} from './knowledge-metadata-repository-core'

const drizzleAdapter: KnowledgeMetadataAdapter = {
  async findByDatasetIds(ids) {
    if (ids.length === 0) return []
    return db.select().from(knowledgeBases).where(inArray(knowledgeBases.ragflowDatasetId, ids))
  },
  async insert(input) {
    const [row] = await db
      .insert(knowledgeBases)
      .values({ id: crypto.randomUUID(), ...input })
      .returning()
    if (!row) throw new Error('Knowledge metadata insert returned no row')
    return row
  },
  async insertDocumentOnConflictDoNothing(ragflowDatasetId) {
    await db
      .insert(knowledgeBases)
      .values({ id: crypto.randomUUID(), ragflowDatasetId, type: 'document' })
      .onConflictDoNothing({ target: knowledgeBases.ragflowDatasetId })
  },
  async ensureType(ragflowDatasetId, type) {
    await db
      .insert(knowledgeBases)
      .values({ id: crypto.randomUUID(), ragflowDatasetId, type })
      .onConflictDoNothing({ target: knowledgeBases.ragflowDatasetId })
    if (type === 'qa') {
      await db
        .update(knowledgeBases)
        .set({ type: 'qa', updatedAt: new Date() })
        .where(eq(knowledgeBases.ragflowDatasetId, ragflowDatasetId))
    }
  },
  async update(ragflowDatasetId, patch) {
    const [row] = await db
      .update(knowledgeBases)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(knowledgeBases.ragflowDatasetId, ragflowDatasetId))
      .returning()
    return row ?? null
  },
}

export const knowledgeMetadataRepository = createKnowledgeMetadataRepository(drizzleAdapter)
