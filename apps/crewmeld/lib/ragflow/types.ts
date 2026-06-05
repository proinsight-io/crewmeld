/**
 * Knowledge base API type definitions
 */

export interface RagflowConfig {
  endpoint: string
  apiKey: string
  timeoutMs: number
}

/**
 * Subset of RagFlow `parser_config` we care about. RagFlow accepts more keys
 * (raptor, knowledge_graph, etc.); callers can cast to add them as needed.
 */
export interface RagflowParserConfig {
  /** Layout recognizer to use. v0.23+ expects a string: 'DeepDOC' (visual, default) or 'Plain Text'. */
  layout_recognize?: 'DeepDOC' | 'Plain Text'
  /** Auto-extract N keywords per chunk via the configured chat LLM (0-30). Fixes orphan chunks. */
  auto_keywords?: number
  /** Auto-generate N Q&A pairs per chunk via LLM (0-10). Improves recall. */
  auto_questions?: number
  /** Token budget per chunk (default 256). */
  chunk_token_num?: number
  /** Custom split delimiter. */
  delimiter?: string
  /** PDF processing batch size. */
  task_page_size?: number
  /** Excel-to-HTML mode. */
  html4excel?: boolean
}

export interface RagflowApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface RagflowChunk {
  id: string
  content: string
  document_id: string
  document_name: string
  dataset_id: string
  similarity: number
  vector_similarity: number
  term_similarity: number
  positions: string[]
  /** Optional image attached to the chunk (e.g. extracted from PDF). Resolve via getImage / image proxy. */
  image_id?: string
}

export interface RagflowRetrievalData {
  chunks: RagflowChunk[]
  doc_aggs: Array<{
    doc_id: string
    doc_name: string
    count: number
  }>
  total: number
}

export interface RagflowDataset {
  id: string
  name: string
  description: string
  language: string
  embedding_model: string
  permission: string
  document_count: number
  chunk_count: number
  parse_method: string
  /** Total bytes of all documents in the knowledge base (returned by some versions) */
  size?: number
  created_at: string | number
  updated_at: string | number
}

export type RagflowDatasetList = RagflowDataset[]

export interface RagflowDocumentInfo {
  id: string
  name: string
  size: number
  type: string
  /** Enabled status: '1'=enabled '0'=disabled */
  status: string
  /** Parse run status: '0'=UNSTART '1'=RUNNING '2'=CANCEL '3'=DONE '4'=FAIL */
  run?: string
  progress: number
  progress_msg: string
  /** Compatible field name: some versions return chunk_num */
  chunk_count?: number
  chunk_num?: number
  /** Compatible field name: some versions return token_num */
  token_count?: number
  token_num?: number
  /** v0.15+ returns created_at, older versions or some deployments return create_time */
  created_at?: string | number
  updated_at?: string | number
  /** Compatible field name */
  create_time?: string | number
  update_time?: string | number
}

export type RagflowDocumentList = RagflowDocumentInfo[]

export interface RagflowDocumentChunkItem {
  id: string
  content: string
  document_id: string
  document_name: string
  dataset_id: string
  /** 1=enabled 0=disabled */
  available_int?: number
  image_id?: string
  positions?: string[]
}

export interface RagflowDocumentChunksData {
  chunks: RagflowDocumentChunkItem[]
  doc: RagflowDocumentInfo
  total: number
}
