import {
  getDocumentChunks,
  getDocumentParseStatus,
  type RagflowConfig,
  type RagflowDocumentChunkItem,
} from '@/lib/ragflow'
import { bindImagesToRealChunks, type ImageBindingDecision } from './binding'
import {
  applyDocumentImageBindings,
  getPendingDocumentImages,
} from './repository'

export interface BindingServiceDependencies {
  getParseStatus(
    config: RagflowConfig,
    datasetId: string,
    documentId: string
  ): Promise<'running' | 'done' | 'failed'>
  getPendingImages(documentId: string, generation: number): ReturnType<typeof getPendingDocumentImages>
  getChunkPage(
    config: RagflowConfig,
    datasetId: string,
    documentId: string,
    page: number,
    pageSize: number
  ): Promise<{ chunks: RagflowDocumentChunkItem[]; total: number }>
  applyBindings(
    documentId: string,
    generation: number,
    decisions: ImageBindingDecision[]
  ): Promise<boolean>
}

export type BindingRunResult =
  | { status: 'waiting' }
  | { status: 'completed'; bound: number; failed: number }
  | { status: 'parse-failed' }
  | { status: 'stale' }

export interface DocumentImageBindingInput {
  config: RagflowConfig
  datasetId: string
  documentId: string
  generation: number
}

const productionDependencies: BindingServiceDependencies = {
  getParseStatus: getDocumentParseStatus,
  getPendingImages: getPendingDocumentImages,
  async getChunkPage(config, datasetId, documentId, page, pageSize) {
    return await getDocumentChunks(config, datasetId, documentId, { page, pageSize })
  },
  applyBindings: applyDocumentImageBindings,
}

async function getAllChunks(
  input: DocumentImageBindingInput,
  dependencies: BindingServiceDependencies
): Promise<RagflowDocumentChunkItem[]> {
  const pageSize = 100
  const chunks: RagflowDocumentChunkItem[] = []
  let page = 1
  let total: number | null = null

  while (total === null || chunks.length < total) {
    const result = await dependencies.getChunkPage(
      input.config,
      input.datasetId,
      input.documentId,
      page,
      pageSize
    )
    total = result.total
    if (result.chunks.length === 0 && chunks.length < total) {
      throw new Error('RAGFlow chunk pagination ended before the declared total')
    }
    chunks.push(...result.chunks)
    if (result.chunks.length === 0 || chunks.length >= total) break
    page += 1
  }

  return chunks.slice(0, total ?? chunks.length)
}

export async function runDocumentImageBinding(
  input: DocumentImageBindingInput,
  dependencies: BindingServiceDependencies = productionDependencies
): Promise<BindingRunResult> {
  const parseStatus = await dependencies.getParseStatus(
    input.config,
    input.datasetId,
    input.documentId
  )
  if (parseStatus === 'running') return { status: 'waiting' }

  const images = await dependencies.getPendingImages(input.documentId, input.generation)
  if (parseStatus === 'failed') {
    const applied = await dependencies.applyBindings(
      input.documentId,
      input.generation,
      images.map((image) => ({
        imageId: image.id,
        chunkId: null,
        status: 'failed' as const,
        error: 'ragflow-parse-failed',
      }))
    )
    return applied ? { status: 'parse-failed' } : { status: 'stale' }
  }

  const chunks = await getAllChunks(input, dependencies)
  const decisions = bindImagesToRealChunks(images, chunks)
  const applied = await dependencies.applyBindings(
    input.documentId,
    input.generation,
    decisions
  )
  if (!applied) return { status: 'stale' }
  return {
    status: 'completed',
    bound: decisions.filter((decision) => decision.status === 'bound').length,
    failed: decisions.filter((decision) => decision.status === 'failed').length,
  }
}
