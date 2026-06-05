/**
 * Conversation layer knowledge query — RAGFlow-backed knowledge retrieval
 */

import { db, digitalEmployees } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { t } from '@/lib/core/server-i18n'
import { buildImageProxyUrl, loadRagflowConfig, RagflowClientError, retrieval } from '@/lib/ragflow'
import type { KnowledgeChunkReference } from './types'

const logger = createLogger('ConversationKnowledgeQuery')

export interface KnowledgeQueryResult {
  /** Whether query succeeded */
  success: boolean
  /** Retrieved content chunks */
  contents: string[]
  /** Concatenated reference text (for injecting into system prompt) */
  referenceText: string
  /** Match result count */
  resultCount: number
  /** Chunk reference metadata (for frontend source display) */
  references: KnowledgeChunkReference[]
}

/**
 * Get employee-bound dataset ID list (from employee config JSON)
 */
async function getEmployeeRagflowDatasetIds(employeeId: string): Promise<string[]> {
  const [employee] = await db
    .select({ config: digitalEmployees.config })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)

  if (!employee) return []

  const config = employee.config as Record<string, unknown> | null
  const ragflowDatasetIds = config?.ragflowDatasetIds
  if (Array.isArray(ragflowDatasetIds)) {
    return ragflowDatasetIds.filter((id): id is string => typeof id === 'string')
  }
  return []
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
  topK = 8
): Promise<KnowledgeQueryResult> {
  const emptyResult: KnowledgeQueryResult = {
    success: false,
    contents: [],
    referenceText: '',
    resultCount: 0,
    references: [],
  }
  const ragflowIds = await getEmployeeRagflowDatasetIds(employeeId)
  if (ragflowIds.length === 0) {
    logger.info(`Employee ${employeeId} has no RAGFlow dataset bound`)
    return emptyResult
  }
  return await queryRagflowKnowledge(employeeId, query, ragflowIds, topK)
}

/**
 * Query RAGFlow datasets.
 */
async function queryRagflowKnowledge(
  employeeId: string,
  query: string,
  datasetIds: string[],
  topK: number
): Promise<KnowledgeQueryResult> {
  const emptyResult: KnowledgeQueryResult = {
    success: false,
    contents: [],
    referenceText: '',
    resultCount: 0,
    references: [],
  }

  try {
    const ragflowConfig = await loadRagflowConfig()

    const data = await retrieval(ragflowConfig, {
      datasetIds,
      query,
      topK,
      similarityThreshold: 0.3,
    })

    const chunks = data.chunks ?? []
    if (chunks.length === 0) {
      logger.info('Knowledge base search returned no matches', {
        employeeId,
        query: query.slice(0, 100),
      })
      return emptyResult
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
    const renderChunkContent = (c: (typeof chunks)[number]): string =>
      c.image_id ? `${c.content}\n\n![](${buildImageProxyUrl(c.image_id)})` : c.content

    const contents = chunks.map(renderChunkContent)
    const referenceText = chunks
      .map((c, i) => `[${t('convKnowledgeReference')}${i + 1}] ${renderChunkContent(c)}`)
      .join('\n\n')
    const references: KnowledgeChunkReference[] = chunks.map((c) => ({
      chunkId: c.id,
      documentId: c.document_id,
      documentName: c.document_name || docNameMap[c.document_id] || c.document_id,
      similarity: c.similarity ?? 0,
      content: renderChunkContent(c),
    }))

    logger.info('Knowledge base search completed', {
      employeeId,
      query: query.slice(0, 100),
      resultCount: chunks.length,
      topSimilarity: chunks[0]?.similarity?.toFixed(3) ?? 'N/A',
    })

    return { success: true, contents, referenceText, resultCount: chunks.length, references }
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
    return emptyResult
  }
}
