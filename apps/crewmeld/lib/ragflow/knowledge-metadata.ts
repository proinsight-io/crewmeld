import type { KnowledgeBaseNavigation, KnowledgeBaseType } from '@crewmeld/db/schema'

export interface KnowledgeMetadata {
  id: string
  ragflowDatasetId: string
  type: KnowledgeBaseType
  thresholdOverride: number | null
  enabled: boolean
  navigation: KnowledgeBaseNavigation
  createdAt: Date
  updatedAt: Date
}

export interface KnowledgeMetadataCreate {
  ragflowDatasetId: string
  type: KnowledgeBaseType
  thresholdOverride?: number | null
  enabled?: boolean
  navigation?: KnowledgeBaseNavigation
}

export interface KnowledgeMetadataRepository {
  findByDatasetIds(ids: string[]): Promise<KnowledgeMetadata[]>
  create(input: KnowledgeMetadataCreate): Promise<KnowledgeMetadata>
  ensureDocument(ragflowDatasetId: string): Promise<KnowledgeMetadata>
  ensureType(ragflowDatasetId: string, type: KnowledgeBaseType): Promise<KnowledgeMetadata>
  update(
    ragflowDatasetId: string,
    patch: Partial<Pick<KnowledgeMetadata, 'thresholdOverride' | 'enabled' | 'navigation'>>
  ): Promise<KnowledgeMetadata | null>
}

export class ImmutableKnowledgeBaseTypeError extends Error {
  readonly code = 'KNOWLEDGE_BASE_TYPE_IMMUTABLE'
}

export class InvalidKnowledgeThresholdError extends Error {
  readonly code = 'KNOWLEDGE_BASE_THRESHOLD_INVALID'
}

export class PartialDatasetCreationError extends Error {
  readonly code = 'RAGFLOW_DATASET_METADATA_PARTIAL_FAILURE'

  constructor(
    readonly datasetId: string,
    options?: ErrorOptions
  ) {
    super('Dataset was created remotely but local metadata and compensation both failed', options)
  }
}

export interface DatasetRemoteOperations<TDataset extends { id: string }> {
  create(): Promise<TDataset>
  delete(datasetId: string): Promise<void>
}

export async function createDatasetWithMetadata<TDataset extends { id: string }>(
  repository: KnowledgeMetadataRepository,
  remote: DatasetRemoteOperations<TDataset>,
  input: Omit<KnowledgeMetadataCreate, 'ragflowDatasetId' | 'type'> & {
    name: string
    type?: KnowledgeBaseType
  }
): Promise<{ dataset: TDataset; metadata: KnowledgeMetadata }> {
  validateThreshold(input.thresholdOverride)
  const dataset = await remote.create()
  try {
    const metadata = await repository.create({
      ragflowDatasetId: dataset.id,
      type: input.type ?? 'document',
      thresholdOverride: input.thresholdOverride,
      enabled: input.enabled,
      navigation: input.navigation,
    })
    return { dataset, metadata }
  } catch (metadataError) {
    try {
      await remote.delete(dataset.id)
    } catch (compensationError) {
      throw new PartialDatasetCreationError(dataset.id, {
        cause: { metadataError, compensationError },
      })
    }
    throw metadataError
  }
}

export async function updateKnowledgeMetadata(
  repository: KnowledgeMetadataRepository,
  datasetId: string,
  patch: Partial<Pick<KnowledgeMetadata, 'type' | 'thresholdOverride' | 'enabled' | 'navigation'>>
): Promise<KnowledgeMetadata | null> {
  if (patch.type !== undefined)
    throw new ImmutableKnowledgeBaseTypeError('Knowledge base type is immutable')
  validateThreshold(patch.thresholdOverride)
  return repository.update(datasetId, patch)
}

export async function reconcileDatasetMetadata(
  repository: KnowledgeMetadataRepository,
  datasetIds: string[]
): Promise<KnowledgeMetadata[]> {
  const existing = await repository.findByDatasetIds(datasetIds)
  const byId = new Map(existing.map((row) => [row.ragflowDatasetId, row]))
  for (const datasetId of datasetIds) {
    if (!byId.has(datasetId)) {
      const created = await repository.ensureDocument(datasetId)
      byId.set(datasetId, created)
    }
  }
  return datasetIds.flatMap((datasetId) => byId.get(datasetId) ?? [])
}

export async function mergeDatasetMetadata<TDataset extends { id: string }>(
  repository: KnowledgeMetadataRepository,
  datasets: TDataset[]
): Promise<Array<TDataset & { metadata: KnowledgeMetadata | null; type: KnowledgeBaseType }>> {
  const rows = await repository.findByDatasetIds(datasets.map((dataset) => dataset.id))
  const byId = new Map(rows.map((row) => [row.ragflowDatasetId, row]))
  return datasets.map((dataset) => {
    const metadata = byId.get(dataset.id) ?? null
    return { ...dataset, metadata, type: metadata?.type ?? 'document' }
  })
}

/** Persist metadata for legacy RAGFlow datasets and merge it into the remote rows. */
export async function reconcileAndMergeDatasetMetadata<
  TDataset extends { id: string; chunk_method?: string; parse_method?: string },
>(
  repository: KnowledgeMetadataRepository,
  datasets: TDataset[]
): Promise<Array<TDataset & { metadata: KnowledgeMetadata; type: KnowledgeBaseType }>> {
  const existing = await repository.findByDatasetIds(datasets.map((dataset) => dataset.id))
  const byId = new Map(existing.map((row) => [row.ragflowDatasetId, row]))
  for (const dataset of datasets) {
    const remoteType: KnowledgeBaseType =
      dataset.chunk_method?.toLowerCase() === 'qa' || dataset.parse_method?.toLowerCase() === 'qa'
        ? 'qa'
        : 'document'
    const current = byId.get(dataset.id)
    if (!current || (remoteType === 'qa' && current.type !== 'qa')) {
      byId.set(dataset.id, await repository.ensureType(dataset.id, remoteType))
    }
  }
  return datasets.map((dataset) => {
    const metadata = byId.get(dataset.id)
    if (!metadata) throw new Error(`Knowledge metadata reconciliation failed: ${dataset.id}`)
    return { ...dataset, metadata, type: metadata.type }
  })
}

function validateThreshold(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new InvalidKnowledgeThresholdError('Threshold override must be between 0 and 1')
  }
}
