export interface ModelDefaultParams {
  temperature: number
  maxTokens: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /**
   * Coding-provider only. Fast/lightweight model identifier. Injected as both
   * `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` for the
   * dev-studio container. Empty/undefined → those env vars are omitted.
   */
  codingFastModel?: string
  /**
   * Coding-provider only. Standard-tier model identifier. Injected as
   * `ANTHROPIC_DEFAULT_SONNET_MODEL`. Empty/undefined → env var omitted.
   */
  codingSonnetModel?: string
  /**
   * Coding-provider only. High-capability model identifier. Injected as
   * `ANTHROPIC_DEFAULT_OPUS_MODEL`. Empty/undefined → env var omitted.
   */
  codingOpusModel?: string
  /**
   * User-defined passthrough parameters merged verbatim into the
   * OpenAI-compatible `/chat/completions` request body (e.g.
   * `{ enable_thinking: false }`). Lets operators toggle vendor-specific
   * options such as thinking mode without code changes. Reserved request keys
   * (model/messages/stream/tools/...) are ignored when the body is assembled.
   */
  extraParams?: Record<string, unknown>
}

export interface ModelConfigData {
  id: string
  providerId: string
  displayName: string
  modelName: string | null
  apiEndpoint: string | null
  hasApiKey: boolean
  defaultParams: ModelDefaultParams
  isActive: boolean
  lastTestedAt: string | null
  lastTestResult: string | null
  lastTestLatencyMs: number | null
  createdAt: string
  updatedAt: string
  providerMeta: ProviderMeta
}

export interface ProviderMeta {
  name: string
  description: string
  models: string[]
  defaultModel: string
}

export interface CreateModelConfigPayload {
  providerId: string
  displayName: string
  modelName?: string
  apiKey?: string
  apiEndpoint?: string
  defaultParams?: Partial<ModelDefaultParams>
}

export interface UpdateModelConfigPayload {
  displayName?: string
  modelName?: string
  apiKey?: string
  apiEndpoint?: string
  defaultParams?: Partial<ModelDefaultParams>
  isActive?: boolean
}

export interface ModelTestResult {
  success: boolean
  message: string
  latencyMs: number
  responsePreview?: string
  model: string
  tokens?: {
    input: number
    output: number
    total: number
  }
}

export interface OllamaModel {
  name: string
  size: number
  modifiedAt: string
  digest: string
}

export interface OllamaDiscoveryResult {
  available: boolean
  endpoint: string
  models: OllamaModel[]
  error?: string
}

export interface ProviderDisplayInfo {
  id: string
  name: string
  description: string
  models: string[]
  defaultModel: string
  configured: boolean
  isActive: boolean
  lastTestedAt: string | null
}
