/**
 * Conversation layer knowledge query — RAGFlow-backed knowledge retrieval
 */

import { db, digitalEmployees, knowledgeBases } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq, inArray } from 'drizzle-orm'
import { t } from '@/lib/core/server-i18n'
import { buildImageProxyUrl, loadRagflowConfig, RagflowClientError, retrieval } from '@/lib/ragflow'
import { attachImagesToChunks } from '@/lib/knowledge/document-images/matching'
import { findBoundDocumentImages } from '@/lib/knowledge/document-images/repository'
import { estimateTokens } from './context'
import type { KnowledgeChunkReference } from './types'

const logger = createLogger('ConversationKnowledgeQuery')

/**
 * Ceiling on how many tokens of retrieved chunk content get injected into the
 * system prompt. Without this, a `topK` of several large chunks can push the
 * knowledge-base reference block alone past the model's context budget (see
 * `resolveContextConfig` in ./context), starving the prompt of room for the
 * actual conversation. Chunks arrive similarity-sorted, so this keeps the
 * best matches and drops the tail rather than truncating mid-chunk.
 */
const MAX_KNOWLEDGE_REFERENCE_TOKENS = 3000

function capChunksByTokenBudget<T extends { content: string }>(items: T[], maxTokens: number): T[] {
  const capped: T[] = []
  let used = 0
  for (const item of items) {
    const tokens = estimateTokens(item.content)
    // Always keep at least the single best match, even if it alone exceeds
    // the budget — some knowledge beats none.
    if (capped.length > 0 && used + tokens > maxTokens) break
    capped.push(item)
    used += tokens
  }
  return capped
}

export interface KnowledgeQueryResult {
  /** Whether query succeeded */
  success: boolean
  /** Retrieved content chunks */
  contents: string[]
  /** Concatenated reference text (for injecting into system prompt) */
  referenceText: string
  /** Match result count */
  resultCount: number
  /** Highest chunk similarity, or null when no chunk was returned */
  maxSimilarity: number | null
  /** Retrieval failed for a technical reason rather than returning no chunks */
  failureType?: 'technical'
  /** Chunk reference metadata (for frontend source display) */
  references: KnowledgeChunkReference[]
}

/**
 * Get employee-bound dataset ID list (from employee config JSON)
 */
export async function getEmployeeRagflowDatasetIds(employeeId: string): Promise<string[]> {
  const [employee] = await db
    .select({ config: digitalEmployees.config })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)

  if (!employee) return []

  const config = employee.config as Record<string, unknown> | null
  const ragflowDatasetIds = config?.ragflowDatasetIds
  if (!Array.isArray(ragflowDatasetIds)) return []
  const requestedIds = [...new Set(ragflowDatasetIds.filter((id): id is string => typeof id === 'string'))]
  if (!requestedIds.length) return []
  const enabledBases = await db
    .select({ ragflowDatasetId: knowledgeBases.ragflowDatasetId })
    .from(knowledgeBases)
    .where(
      and(
        inArray(knowledgeBases.ragflowDatasetId, requestedIds),
        eq(knowledgeBases.enabled, true)
      )
    )
  return enabledBases.map((base) => base.ragflowDatasetId)
}

/**
 * Check if employee has any RAGFlow dataset bound.
 * Used during intent classification to determine if knowledge base search path is needed.
 */
export async function getEmployeeKnowledgeBaseIds(employeeId: string): Promise<string[]> {
  return await getEmployeeRagflowDatasetIds(employeeId)
}

/**
 * Query employee-bound RAGFlow datasets.
 */
export async function queryEmployeeKnowledge(
  employeeId: string,
  query: string,
  topK = 8,
  requestedDatasetIds?: string[],
  isPublicChannel = false
): Promise<KnowledgeQueryResult> {
  const emptyResult: KnowledgeQueryResult = {
    success: false,
    contents: [],
    referenceText: '',
    resultCount: 0,
    maxSimilarity: null,
    references: [],
  }
  const ragflowIds = await getEmployeeRagflowDatasetIds(employeeId)
  if (ragflowIds.length === 0) {
    logger.info(`Employee ${employeeId} has no RAGFlow dataset bound`)
    return emptyResult
  }
  const datasetIds =
    requestedDatasetIds && requestedDatasetIds.length > 0
      ? ragflowIds.filter((id) => requestedDatasetIds.includes(id))
      : ragflowIds
  if (datasetIds.length === 0) return emptyResult
  return await queryRagflowKnowledge(employeeId, query, datasetIds, topK, isPublicChannel)
}

/**
 * Query RAGFlow datasets.
 */
async function queryRagflowKnowledge(
  employeeId: string,
  query: string,
  datasetIds: string[],
  topK: number,
  isPublicChannel: boolean
): Promise<KnowledgeQueryResult> {
  const emptyResult: KnowledgeQueryResult = {
    success: false,
    contents: [],
    referenceText: '',
    resultCount: 0,
    maxSimilarity: null,
    references: [],
  }

  try {
    const ragflowConfig = await loadRagflowConfig()

    const data = await retrieval(ragflowConfig, {
      datasetIds,
      query,
      topK,
      similarityThreshold: 0,
    })

    // Public-API conversations (e.g. the H5 client) have no admin session, so
    // image markdown must point at the employee-API-key-authenticated public
    // image routes instead of the session-gated admin ones.
    const publicEmployeeId = isPublicChannel ? employeeId : undefined

    const retrievedChunks = (data.chunks ?? []).filter((chunk) => Number.isFinite(chunk.similarity))
    let chunks = retrievedChunks
    try {
      const storedImages = await findBoundDocumentImages(retrievedChunks.map((chunk) => chunk.id))
      chunks = attachImagesToChunks(retrievedChunks, storedImages, publicEmployeeId)
    } catch (imageError) {
      logger.warn('Document image lookup failed; continuing with text-only chunks', {
        error: imageError instanceof Error ? imageError.message : String(imageError),
      })
    }
    if (chunks.length === 0) {
      logger.info('Knowledge base search returned no usable matches', {
        employeeId,
        query: query.slice(0, 100),
      })
      return emptyResult
    }

    const maxSimilarity = Math.max(...chunks.map((chunk) => chunk.similarity))
    if (maxSimilarity < 0.3) {
      logger.info('Knowledge base search returned only low-similarity matches', {
        employeeId,
        query: query.slice(0, 100),
        resultCount: chunks.length,
        maxSimilarity,
      })
      return { ...emptyResult, resultCount: chunks.length, maxSimilarity }
    }

    // Debug: print raw RAGflow response structure
    logger.info('[DEBUG] RAGflow retrieval raw data', {
      totalChunks: chunks.length,
      firstChunk: chunks[0]
        ? {
            id: chunks[0].id,
            document_id: chunks[0].document_id,
            document_name: chunks[0].document_name,
            chunkKeys: Object.keys(chunks[0]),
          }
        : null,
      doc_aggs: data.doc_aggs,
    })

    // doc_aggs provides doc_id -> doc_name mapping, as fallback when chunk.document_name is empty
    const docNameMap: Record<string, string> = {}
    for (const agg of data.doc_aggs ?? []) {
      if (agg.doc_id && agg.doc_name) {
        docNameMap[agg.doc_id] = agg.doc_name
      }
    }

    // Append a markdown image to chunk content when RagFlow attached one (e.g.
    // figures extracted from a PDF). The chat UI renders the image inline via
    // the same-origin proxy route.
    const renderChunkContent = (c: (typeof chunks)[number]): string => {
      const urls = [
        ...(c.image_id ? [buildImageProxyUrl(c.image_id, publicEmployeeId)] : []),
        ...(c.images ?? []).map((image) => image.url),
      ]
      const uniqueUrls = [...new Set(urls)]
      return uniqueUrls.length > 0
        ? `${c.content}\n\n${uniqueUrls.map((url) => `![](${url})`).join('\n')}`
        : c.content
    }

    const boundedChunks = capChunksByTokenBudget(
      chunks.map((c) => ({ ...c, content: renderChunkContent(c) })),
      MAX_KNOWLEDGE_REFERENCE_TOKENS
    )
    const contents = boundedChunks.map((c) => c.content)
    const referenceText = boundedChunks
      .map((c, i) => `[${t('convKnowledgeReference')}${i + 1}] ${c.content}`)
      .join('\n\n')
    const references: KnowledgeChunkReference[] = boundedChunks.map((c) => ({
      chunkId: c.id,
      documentId: c.document_id,
      documentName: c.document_name || docNameMap[c.document_id] || c.document_id,
      similarity: c.similarity,
      content: c.content,
    }))

    logger.info('Knowledge base search completed', {
      employeeId,
      query: query.slice(0, 100),
      resultCount: chunks.length,
      boundedResultCount: boundedChunks.length,
      topSimilarity: chunks[0]?.similarity?.toFixed(3) ?? 'N/A',
    })

    return {
      success: true,
      contents,
      referenceText,
      resultCount: chunks.length,
      maxSimilarity,
      references,
    }
  } catch (error) {
    if (error instanceof RagflowClientError) {
      logger.error('Knowledge base search failed', {
        employeeId,
        errorType: error.type,
        message: error.message,
      })
    } else {
      logger.error('Knowledge base search error', { employeeId, error })
    }
    return { ...emptyResult, failureType: 'technical' }
  }
}
