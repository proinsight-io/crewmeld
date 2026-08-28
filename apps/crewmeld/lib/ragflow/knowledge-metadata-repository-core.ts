import type {
  KnowledgeMetadata,
  KnowledgeMetadataCreate,
  KnowledgeMetadataRepository,
} from './knowledge-metadata'
import type { KnowledgeBaseType } from '@crewmeld/db/schema'

export interface KnowledgeMetadataAdapter {
  findByDatasetIds(ids: string[]): Promise<KnowledgeMetadata[]>
  insert(input: KnowledgeMetadataCreate): Promise<KnowledgeMetadata>
  insertDocumentOnConflictDoNothing(ragflowDatasetId: string): Promise<void>
  ensureType(ragflowDatasetId: string, type: KnowledgeBaseType): Promise<void>
  update(
    ragflowDatasetId: string,
    patch: Partial<Pick<KnowledgeMetadata, 'thresholdOverride' | 'enabled' | 'navigation'>>
  ): Promise<KnowledgeMetadata | null>
}

export function createKnowledgeMetadataRepository(
  adapter: KnowledgeMetadataAdapter
): KnowledgeMetadataRepository {
  return {
    findByDatasetIds: (ids) => adapter.findByDatasetIds(ids),
    create: (input) => adapter.insert(input),
    async ensureDocument(ragflowDatasetId) {
      await adapter.insertDocumentOnConflictDoNothing(ragflowDatasetId)
      const [row] = await adapter.findByDatasetIds([ragflowDatasetId])
      if (!row) throw new Error('Knowledge metadata upsert returned no row')
      return row
    },
    async ensureType(ragflowDatasetId, type) {
      await adapter.ensureType(ragflowDatasetId, type)
      const [row] = await adapter.findByDatasetIds([ragflowDatasetId])
      if (!row) throw new Error('Knowledge metadata reconciliation returned no row')
      return row
    },
    update: (ragflowDatasetId, patch) => adapter.update(ragflowDatasetId, patch),
  }
}
