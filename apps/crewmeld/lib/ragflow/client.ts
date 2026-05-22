import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { Agent } from 'undici'
import { decryptConfig } from '@/lib/connectors/encryption'
import type { ConnectionConfig } from '@/lib/connectors/types'
import { t } from '@/lib/core/server-i18n'
import { classifyHttpError, RagflowClientError, RagflowErrorType } from './errors'
import type {
  RagflowApiResponse,
  RagflowConfig,
  RagflowDataset,
  RagflowDatasetList,
  RagflowDocumentChunksData,
  RagflowDocumentInfo,
  RagflowDocumentList,
  RagflowRetrievalData,
} from './types'

const logger = createLogger('RagflowClient')
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Standalone undici Agent, bypasses global proxy dispatcher, knowledge base always connects directly
 */
const directAgent = new Agent()

/**
 * Load config from system_connections row.
 *
 * Distinguishes two failure scenarios:
 * - ConfigMissing: no ragflow connection row exists, or row has empty endpoint / apiKey (not configured)
 * - ConnectionFailed: config values present but connection status is not `connected` (connection problem)
 */
export async function loadRagflowConfig(): Promise<RagflowConfig> {
  // In E2E mock mode, return a stub config pointing to the Playwright mock URL.
  // MSW intercepts outbound HTTP to that URL server-side; no DB query needed.
  if (process.env.E2E_MOCK_SERVER === '1') {
    return {
      endpoint: 'http://mock-ragflow.local',
      apiKey: 'e2e-mock-key',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }
  }

  // First check if a ragflow connection row exists (any status)
  const rows = await db
    .select()
    .from(systemConnections)
    .where(eq(systemConnections.type, 'ragflow'))
    .limit(1)

  if (rows.length === 0) {
    throw new RagflowClientError(RagflowErrorType.ConfigMissing, t('ragflowNotConfigured'))
  }

  const row = rows[0]
  let config: ConnectionConfig
  try {
    config = JSON.parse(decryptConfig(row.configEncrypted)) as ConnectionConfig
  } catch {
    throw new RagflowClientError(RagflowErrorType.ConnectionFailed, t('ragflowDecryptFailed'))
  }

  const endpoint = config.ragflowEndpoint ?? config.apiEndpoint
  if (!endpoint || !config.apiKey) {
    // Row exists but critical fields empty -> not configured
    throw new RagflowClientError(RagflowErrorType.ConfigMissing, t('ragflowMissingConfig'))
  }

  if (row.status !== 'connected') {
    // Config values present but status not connected -> connection problem
    throw new RagflowClientError(
      RagflowErrorType.ConnectionFailed,
      'Knowledge base connection status is not connected'
    )
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    apiKey: config.apiKey,
    timeoutMs: config.ragflowTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Generic API request with timeout
 */
async function ragflowRequest<T>(
  config: RagflowConfig,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  const url = `${config.endpoint}${path}`
  try {
    // In E2E mock mode, omit the undici dispatcher so MSW's fetch interceptor
    // can intercept outbound HTTP calls to the mock RAGFlow URL.
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...options.headers,
      },
    }
    if (process.env.E2E_MOCK_SERVER !== '1') {
      // Bypass global proxy, knowledge base always connects directly
      fetchOptions.dispatcher = directAgent
    }
    const response = await fetch(url, fetchOptions)

    const text = await response.text()
    if (!response.ok) {
      throw classifyHttpError(response.status, text)
    }

    let parsed: RagflowApiResponse<T>
    try {
      parsed = JSON.parse(text) as RagflowApiResponse<T>
    } catch {
      const detail = text.slice(0, 200)
      throw new RagflowClientError(
        RagflowErrorType.InvalidResponse,
        `${t('ragflowInvalidResponse')}: ${detail}`,
        undefined,
        detail
      )
    }

    if (parsed.code !== 0) {
      const detail = `code=${parsed.code}: ${parsed.message}`
      throw new RagflowClientError(
        RagflowErrorType.ServerError,
        `${t('ragflowApiError')} (${detail})`,
        undefined,
        detail
      )
    }

    return parsed.data
  } catch (error) {
    if (error instanceof RagflowClientError) throw error
    if ((error as Error).name === 'AbortError') {
      const detail = `${config.timeoutMs}ms`
      throw new RagflowClientError(
        RagflowErrorType.Timeout,
        `${t('ragflowTimeout')} (${detail})`,
        undefined,
        detail
      )
    }
    const err = error as Error & { cause?: Error }
    // The real error cause of Node.js fetch is hidden in cause (e.g. ECONNREFUSED, ENOTFOUND)
    logger.error('Knowledge base fetch error details', {
      message: err.message,
      name: err.name,
      cause: err.cause
        ? { message: err.cause.message, code: (err.cause as NodeJS.ErrnoException).code }
        : undefined,
    })
    const cause = err.cause
    const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code
    const detail = causeCode
      ? `${causeCode} — ${cause?.message ?? ''}`
      : (cause?.message ?? err.message)
    let hint = ''
    if (causeCode === 'ECONNREFUSED') {
      hint = t('ragflowConnRefused')
    } else if (causeCode === 'ENOTFOUND') {
      hint = t('ragflowDnsError')
    } else if (causeCode === 'ECONNRESET' || causeCode === 'EPIPE') {
      hint = t('ragflowConnReset')
    } else if (err.message === 'fetch failed') {
      hint = t('ragflowTlsError')
    }
    throw new RagflowClientError(
      RagflowErrorType.NetworkError,
      `${t('ragflowNetworkError')}: ${detail}${hint}`,
      undefined,
      detail
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST /api/v1/retrieval - hybrid retrieval
 */
export async function retrieval(
  config: RagflowConfig,
  params: {
    datasetIds: string[]
    query: string
    topK?: number
    similarityThreshold?: number
  }
): Promise<RagflowRetrievalData> {
  return ragflowRequest<RagflowRetrievalData>(config, '/api/v1/retrieval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: params.datasetIds,
      question: params.query,
      top_k: params.topK ?? 6,
      similarity_threshold: params.similarityThreshold ?? 0.2,
    }),
  })
}

/**
 * POST /api/v1/datasets - create knowledge base
 */
export async function createDataset(
  config: RagflowConfig,
  params: { name: string; description?: string }
): Promise<RagflowDataset> {
  return ragflowRequest<RagflowDataset>(config, '/api/v1/datasets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      description: params.description ?? '',
    }),
  })
}

/**
 * PUT /api/v1/datasets/{id} - update knowledge base name and/or description
 */
export async function updateDataset(
  config: RagflowConfig,
  datasetId: string,
  params: { name?: string; description?: string }
): Promise<void> {
  const body: Record<string, string> = {}
  if (params.name !== undefined) body.name = params.name
  if (params.description !== undefined) body.description = params.description
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
}

/**
 * DELETE /api/v1/datasets - delete knowledge base (v0.15+ API requires ids array)
 */
export async function deleteDataset(config: RagflowConfig, datasetId: string): Promise<void> {
  await ragflowRequest<Record<string, never>>(config, '/api/v1/datasets', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [datasetId] }),
  })
}

/**
 * GET /api/v1/datasets - list knowledge bases
 */
export async function listDatasets(
  config: RagflowConfig,
  params?: { page?: number; pageSize?: number; name?: string }
): Promise<RagflowDatasetList> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.pageSize) searchParams.set('page_size', String(params.pageSize))
  if (params?.name) searchParams.set('name', params.name)

  const qs = searchParams.toString()
  return ragflowRequest<RagflowDatasetList>(config, `/api/v1/datasets${qs ? `?${qs}` : ''}`)
}

/**
 * GET /api/v1/datasets?id={id} - knowledge base details
 * v0.15+ does not support GET /datasets/{id} (only PUT/DELETE), use query param instead
 */
export async function getDataset(
  config: RagflowConfig,
  datasetId: string
): Promise<RagflowDataset> {
  const list = await ragflowRequest<RagflowDatasetList>(
    config,
    `/api/v1/datasets?id=${encodeURIComponent(datasetId)}`
  )
  if (!list || list.length === 0) {
    throw new RagflowClientError(
      RagflowErrorType.NotFound,
      `${t('ragflowDatasetNotFound')}: ${datasetId}`
    )
  }
  return list[0]
}

/**
 * GET /api/v1/datasets/{id}/documents - document list
 * v0.15+ returns { docs: [...], total: N }, compatible with direct array format
 */
export async function listDocuments(
  config: RagflowConfig,
  datasetId: string,
  params?: { page?: number; pageSize?: number }
): Promise<RagflowDocumentList> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.pageSize) searchParams.set('page_size', String(params.pageSize))

  const qs = searchParams.toString()
  const result = await ragflowRequest<
    { docs: RagflowDocumentInfo[]; total: number } | RagflowDocumentInfo[]
  >(config, `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents${qs ? `?${qs}` : ''}`)
  if (Array.isArray(result)) return result
  return (result as { docs: RagflowDocumentInfo[] }).docs ?? []
}

/**
 * POST multipart/form-data - upload document
 */
export async function uploadDocument(
  config: RagflowConfig,
  datasetId: string,
  file: Blob,
  filename: string
): Promise<RagflowDocumentInfo[]> {
  const formData = new FormData()
  formData.append('file', file, filename)

  return ragflowRequest<RagflowDocumentInfo[]>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
    {
      method: 'POST',
      body: formData,
    }
  )
}

/**
 * POST /api/v1/datasets/{id}/chunks - trigger document parsing
 * This endpoint must be called after uploading documents to start chunking
 */
export async function parseDocuments(
  config: RagflowConfig,
  datasetId: string,
  documentIds: string[]
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_ids: documentIds }),
    }
  )
  logger.info(
    `Triggering document parsing: dataset=${datasetId}, documents=${documentIds.join(',')}`
  )
}

/**
 * DELETE /api/v1/datasets/{id}/chunks - stop document parsing
 */
export async function stopDocumentsParsing(
  config: RagflowConfig,
  datasetId: string,
  documentIds: string[]
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_ids: documentIds }),
    }
  )
  logger.info(`Stopping document parsing: dataset=${datasetId}, documents=${documentIds.join(',')}`)
}

/**
 * DELETE /api/v1/datasets/{id}/documents - delete document (v0.15+ API requires ids array)
 */
export async function deleteDocument(
  config: RagflowConfig,
  datasetId: string,
  documentId: string
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [documentId] }),
    }
  )
}

/**
 * GET /api/v1/datasets/{datasetId}/documents?id={documentId} - document details
 * v0.15+ does not support GET /documents/{id}, use query param filter instead
 */
export async function getDocument(
  config: RagflowConfig,
  datasetId: string,
  documentId: string
): Promise<RagflowDocumentInfo> {
  const result = await ragflowRequest<
    { docs: RagflowDocumentInfo[]; total: number } | RagflowDocumentInfo[]
  >(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?id=${encodeURIComponent(documentId)}`
  )
  const list = Array.isArray(result)
    ? result
    : ((result as { docs: RagflowDocumentInfo[] }).docs ?? [])
  if (list.length === 0) {
    throw new RagflowClientError(
      RagflowErrorType.NotFound,
      `${t('ragflowDocNotFound')}: ${documentId}`
    )
  }
  return list[0]
}

/**
 * PUT /api/v1/datasets/{datasetId}/documents - update document enabled status
 */
export async function updateDocumentEnabled(
  config: RagflowConfig,
  datasetId: string,
  documentId: string,
  enabled: boolean
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }
  )
}

/**
 * PUT /api/v1/datasets/{datasetId}/documents/{documentId} - rename document
 */
export async function renameDocument(
  config: RagflowConfig,
  datasetId: string,
  documentId: string,
  name: string
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }
  )
}

/**
 * GET /api/v1/datasets/{datasetId}/documents/{documentId} - download document raw content
 */
export async function downloadDocument(
  config: RagflowConfig,
  datasetId: string,
  documentId: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(
      `${config.endpoint}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${config.apiKey}` },
        // @ts-expect-error undici dispatcher passes through Node.js fetch
        dispatcher: directAgent,
      }
    )
    return response
  } finally {
    clearTimeout(timer)
  }
}

/**
 * PUT /api/v1/datasets/{datasetId}/chunks/{chunkId} - update chunk enabled status
 */
export async function updateChunk(
  config: RagflowConfig,
  datasetId: string,
  documentId: string,
  chunkId: string,
  available: boolean
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks/${encodeURIComponent(chunkId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ available_int: available ? 1 : 0 }),
    }
  )
}

/**
 * DELETE /api/v1/datasets/{datasetId}/chunks - batch delete chunks
 */
export async function deleteChunks(
  config: RagflowConfig,
  datasetId: string,
  chunkIds: string[]
): Promise<void> {
  await ragflowRequest<Record<string, never>>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunk_ids: chunkIds }),
    }
  )
}

/**
 * GET /api/v1/datasets/{datasetId}/chunks - get document chunk list
 */
export async function getDocumentChunks(
  config: RagflowConfig,
  datasetId: string,
  documentId: string,
  params?: { keywords?: string; page?: number; pageSize?: number }
): Promise<RagflowDocumentChunksData> {
  const searchParams = new URLSearchParams()
  if (params?.keywords) searchParams.set('keywords', params.keywords)
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.pageSize) searchParams.set('page_size', String(params.pageSize))

  const qs = searchParams.toString()
  return ragflowRequest<RagflowDocumentChunksData>(
    config,
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks${qs ? `?${qs}` : ''}`
  )
}

/**
 * Health check — lightweight probe
 *
 * Returns a locale-neutral result. The caller (connectors/tester.ts) maps
 * `errorType` to a UI-locale i18n key and shows `detail` verbatim. This avoids
 * baking a server-side translation into DB/API payloads.
 */
export async function healthCheck(
  config: RagflowConfig
): Promise<{ ok: true } | { ok: false; errorType: RagflowErrorType; detail: string }> {
  try {
    await ragflowRequest<RagflowDatasetList>(config, '/api/v1/datasets?page=1&page_size=1')
    return { ok: true }
  } catch (error) {
    logger.warn('Knowledge base health check failed', error)
    if (error instanceof RagflowClientError) {
      return { ok: false, errorType: error.type, detail: error.detail }
    }
    const err = error as Error
    return {
      ok: false,
      errorType: RagflowErrorType.NetworkError,
      detail: err?.message ?? 'Unknown error',
    }
  }
}
