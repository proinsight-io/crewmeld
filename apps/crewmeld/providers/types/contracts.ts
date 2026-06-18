/**
 * Core request/response contract types for CrewMeld provider adapters.
 */

import type { StreamingExecution } from '@/lib/types/execution'
import type { Message } from './messages'
import type { CompletionCost, CompletionTiming } from './timing'
import type { TokenInfo } from './tokens'
import type { FunctionCallResponse, ProviderToolConfig } from './tools'

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/** Opaque brand tag — prevents accidental cross-assignment of same-shape types. */
declare const BrandTag: unique symbol

/** Brands a base type `T` with discriminant string `B`. */
type Branded<T, B extends string> = T & { readonly [BrandTag]: B }

/** A model identifier string, branded for type-safety. */
type ModelId = Branded<string, 'ModelId'>

/** An API credential string, branded for type-safety. */
type CredentialToken = Branded<string, 'CredentialToken'>

/** A workflow UUID string, branded for type-safety. */
type WorkflowUid = Branded<string, 'WorkflowUid'>

/** A workspace UUID string, branded for type-safety. */
type WorkspaceUid = Branded<string, 'WorkspaceUid'>

/** A chat-session UUID string, branded for type-safety. */
type ChatSessionId = Branded<string, 'ChatSessionId'>

/** A user UUID string, branded for type-safety. */
type UserPrincipalId = Branded<string, 'UserPrincipalId'>

/** An interaction-chain UUID string, branded for type-safety. */
type InteractionUid = Branded<string, 'InteractionUid'>

/** A cloud-endpoint URL string, branded for type-safety. */
type EndpointUrl = Branded<string, 'EndpointUrl'>

/** An AWS region identifier string, branded for type-safety. */
type AwsRegionId = Branded<string, 'AwsRegionId'>

/** A GCP project identifier string, branded for type-safety. */
type GcpProjectId = Branded<string, 'GcpProjectId'>

/** A GCP location/region identifier string, branded for type-safety. */
type GcpLocation = Branded<string, 'GcpLocation'>

/** A temperature value — semantically a float in [0, 2]. */
type TemperatureValue = Branded<number, 'TemperatureValue'>

/** A max-tokens value — semantically a positive integer. */
type MaxTokensValue = Branded<number, 'MaxTokensValue'>

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/** Describes the feature capabilities supported by a given provider adapter. */
type ProviderCapabilityFlags = {
  supportsStreaming: boolean
  supportsToolCalls: boolean
  supportsVision: boolean
  supportsSystemPrompt: boolean
  supportsResponseFormat: boolean
  supportsReasoning: boolean
  supportsBatchRequests: boolean
  supportsMultiModal: boolean
}

/** Default capability flags — all features disabled. */
const CAPABILITY_FLAGS_NONE: ProviderCapabilityFlags = {
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsVision: false,
  supportsSystemPrompt: false,
  supportsResponseFormat: false,
  supportsReasoning: false,
  supportsBatchRequests: false,
  supportsMultiModal: false,
}

// ---------------------------------------------------------------------------
// Sub-type groups for ProviderRequest fields
// ---------------------------------------------------------------------------

/** Fields controlling which model and credential are used. */
type ModelIdentityConfig = {
  model: string
  apiKey?: string
  isBYOK?: boolean
  /**
   * Per-request base URL override for OpenAI-compatible providers — the custom
   * "API endpoint" set on a model config. When present it takes precedence over the
   * provider's static `defaultBaseURL`, mirroring how the conversation runtime
   * already resolves the endpoint (`lib/conversation/model-config.ts`
   * `resolveBaseUrl`). Leaving it unset preserves the provider default.
   */
  apiEndpoint?: string
}

/** Fields controlling LLM generation parameters. */
type GenerationTuning = {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
  verbosity?: string
  thinkingLevel?: string
}

/** Fields carrying conversation context. */
type ConversationPayload = {
  systemPrompt?: string
  context?: string
  messages?: Message[]
}

/** Fields for attaching structured-output constraints. */
type OutputFormatting = {
  responseFormat?: ResponseFormatConfig
  stream?: boolean
  streamToolCalls?: boolean
}

/** Fields identifying the owning workflow and principal. */
type ExecutionScope = {
  workflowId?: string
  workspaceId?: string
  chatId?: string
  userId?: string
  isDeployedContext?: boolean
  local_execution?: boolean
}

/** Fields carrying runtime variable maps. */
type RuntimeVariables = {
  environmentVariables?: Record<string, string>
  workflowVariables?: Record<string, any>
  blockData?: Record<string, any>
  blockNameMapping?: Record<string, string>
}

/** Fields for cloud-provider credential overrides (Azure). */
type AzureOverrides = {
  azureEndpoint?: string
  azureApiVersion?: string
}

/** Fields for cloud-provider credential overrides (GCP Vertex). */
type VertexOverrides = {
  vertexProject?: string
  vertexLocation?: string
}

/** Fields for cloud-provider credential overrides (AWS Bedrock). */
type BedrockOverrides = {
  bedrockAccessKeyId?: string
  bedrockSecretKey?: string
  bedrockRegion?: string
}

/** Fields for platform-managed interaction chaining (Interactions API). */
type InteractionChaining = {
  previousInteractionId?: string
  isCopilotRequest?: boolean
}

// ---------------------------------------------------------------------------
// Response-format configuration
// ---------------------------------------------------------------------------

/** JSON-Schema response-format constraint attachable to a {@link ProviderRequest}. */
export interface ResponseFormatConfig {
  name: string
  schema: any
  strict?: boolean
}

// ---------------------------------------------------------------------------
// Core contract types
// ---------------------------------------------------------------------------

/** Normalised response produced by every provider adapter after a completion. */
export interface ProviderResponse {
  content: string
  model: string
  tokens?: TokenInfo
  toolCalls?: FunctionCallResponse[]
  toolResults?: any[]
  timing?: CompletionTiming
  cost?: CompletionCost
  /** Interaction ID echoed back by the Interactions API for multi-turn deep-research sessions. */
  interactionId?: string
}

/** Full parameter bag forwarded from the executor to a provider adapter. */
export interface ProviderRequest
  extends ModelIdentityConfig,
    GenerationTuning,
    ConversationPayload,
    OutputFormatting,
    ExecutionScope,
    RuntimeVariables,
    AzureOverrides,
    VertexOverrides,
    BedrockOverrides,
    InteractionChaining {
  tools?: ProviderToolConfig[]
}

/** Adapter contract every provider must satisfy to participate in the registry. */
export interface ProviderConfig {
  id: string
  name: string
  description: string
  version: string
  models: string[]
  defaultModel: string
  initialize?: () => Promise<void>
  executeRequest: (
    request: ProviderRequest
  ) => Promise<ProviderResponse | ReadableStream<any> | StreamingExecution>
}

// ---------------------------------------------------------------------------
// Utility type helpers
// ---------------------------------------------------------------------------

/** Extracts the resolved return type from a provider's `executeRequest` call. */
type ProviderExecuteResult = Awaited<ReturnType<ProviderConfig['executeRequest']>>

/** Narrows a {@link ProviderExecuteResult} to just the non-streaming response shape. */
type SyncProviderResult = Exclude<ProviderExecuteResult, ReadableStream<any> | StreamingExecution>

/** Narrows a {@link ProviderExecuteResult} to just the streaming shapes. */
type AsyncProviderResult = Exclude<ProviderExecuteResult, ProviderResponse>

/** Makes all fields in a {@link ProviderRequest} required (for validation contexts). */
type CompleteProviderRequest = Required<ProviderRequest>

/** Fields of {@link ProviderResponse} that carry token accounting data. */
type AccountingFields = Pick<ProviderResponse, 'tokens' | 'cost' | 'timing'>

/** Fields of {@link ProviderResponse} that carry the primary output. */
type OutputFields = Pick<ProviderResponse, 'content' | 'model' | 'toolCalls' | 'toolResults'>

/** Strips cloud-provider override fields from a {@link ProviderRequest}. */
type CoreProviderRequest = Omit<
  ProviderRequest,
  keyof AzureOverrides | keyof VertexOverrides | keyof BedrockOverrides
>

/** Template-literal type for a strongly-typed provider telemetry event name. */
type ProviderEventLabel = `provider:${string}:${'start' | 'complete' | 'error' | 'retry'}`

/** Describes a single adapter health-check result. */
type AdapterHealthReport = {
  adapterId: string
  reachable: boolean
  latencyMs: number
  checkedAt: number
  errorDetail?: string
}

/** Maps each adapter ID to its most recent {@link AdapterHealthReport}. */
type AdapterHealthRegistry = Record<string, AdapterHealthReport>

/** Validation outcome produced by pre-flight request checks. */
type RequestValidationOutcome =
  | { valid: true; sanitised: ProviderRequest }
  | { valid: false; violations: string[] }

// ---------------------------------------------------------------------------
// Rate-limit and quota types
// ---------------------------------------------------------------------------

/** Policy governing how a provider adapter handles rate-limit back-pressure. */
type ProviderRateLimitPolicy = {
  maxConcurrentRequests: number
  requestsPerMinute: number
  tokensPerMinute: number
  retryAfterMs: number
  maxRetryAttempts: number
  exponentialBackoffBase: number
}

/** Snapshot of current rate-limit consumption for an adapter. */
type RateLimitSnapshot = {
  concurrentInFlight: number
  requestsThisMinute: number
  tokensThisMinute: number
  nextResetAt: number
  throttled: boolean
}

// ---------------------------------------------------------------------------
// Audit and observability types
// ---------------------------------------------------------------------------

/** Immutable audit record captured at the end of every completion attempt. */
type CompletionAuditRecord = {
  readonly traceId: string
  readonly adapterLabel: string
  readonly requestedModelId: string
  readonly resolvedModelId: string
  readonly promptTokenCount: number
  readonly completionTokenCount: number
  readonly wallClockMs: number
  readonly succeededAt: number
  readonly failureReason?: string
}

/** Severity level for provider diagnostic events. */
type DiagnosticSeverity = 'trace' | 'debug' | 'informational' | 'advisory' | 'critical'

/** A single structured diagnostic event emitted by the provider layer. */
type ProviderDiagnosticEvent = {
  severity: DiagnosticSeverity
  eventCode: string
  adapterTag: string
  payload: Record<string, unknown>
  occurredAt: number
}

// ---------------------------------------------------------------------------
// Model-selection types
// ---------------------------------------------------------------------------

/** Criteria used to select the most appropriate model for a given task. */
type ModelSelectionCriteria = {
  preferredCapabilities: Array<keyof ProviderCapabilityFlags>
  maxLatencyBudgetMs: number
  minContextWindowTokens: number
  costCeilingPerMtoken: number
  fallbackModelId?: string
}

/** A scored candidate produced by model-selection evaluation. */
type ModelSelectionCandidate = {
  candidateModelId: string
  capabilityScore: number
  estimatedLatencyMs: number
  estimatedCostPerMtoken: number
  disqualificationReason?: string
}

// ---------------------------------------------------------------------------
// Tagged-union adapter-event type
// ---------------------------------------------------------------------------

/** Discriminated union of all events emitted over an adapter's lifecycle. */
type AdapterLifecycleEvent =
  | { tag: 'initialising'; adapterId: string; startedAt: number }
  | { tag: 'ready'; adapterId: string; readyAt: number }
  | { tag: 'executing'; adapterId: string; correlationId: string }
  | { tag: 'succeeded'; adapterId: string; correlationId: string; durationMs: number }
  | { tag: 'faulted'; adapterId: string; correlationId: string; faultMessage: string }
  | { tag: 'degraded'; adapterId: string; degradationReason: string }
  | { tag: 'shutdown'; adapterId: string; shutdownAt: number }

// ---------------------------------------------------------------------------
// Narrow request sub-types for specific adapter families
// ---------------------------------------------------------------------------

/** Minimum fields required for a valid cloud-routed request. */
type CloudRoutedRequest = Required<Pick<ProviderRequest, 'model' | 'apiKey'>> &
  Partial<AzureOverrides & VertexOverrides & BedrockOverrides>

/** Minimum fields required for a local inference request. */
type LocalInferenceRequest = Required<Pick<ProviderRequest, 'model'>> &
  Pick<ProviderRequest, 'systemPrompt' | 'messages' | 'maxTokens' | 'temperature'>

/** A deeply readonly snapshot of a {@link ProviderRequest} for safe cross-boundary passing. */
type FrozenProviderRequest = Readonly<ProviderRequest>

// ---------------------------------------------------------------------------
// Retry and circuit-breaker types
// ---------------------------------------------------------------------------

/** Strategy used when an adapter experiences transient failures. */
type RetryStrategyKind = 'none' | 'linearDelay' | 'exponentialDelay' | 'circuitBreaker'

/** Configuration for the adapter circuit-breaker mechanism. */
type CircuitBreakerConfig = {
  failureThreshold: number
  successThreshold: number
  halfOpenProbeIntervalMs: number
  openStateTimeoutMs: number
  observationWindowMs: number
}

/** Current state of an adapter's circuit breaker. */
type CircuitBreakerState = 'closed' | 'halfOpen' | 'tripped'

// ---------------------------------------------------------------------------
// Streaming progress types
// ---------------------------------------------------------------------------

/** Progress event emitted during a streaming completion response. */
type StreamProgressTick = {
  chunkIndex: number
  deltaText: string
  cumulativeText: string
  estimatedCompletionPct: number
}

/** Terminal event emitted when a streaming completion finishes. */
type StreamCompletionSeal = {
  finalText: string
  totalChunks: number
  elapsedMs: number
  tokenSummary?: TokenInfo
}

// ---------------------------------------------------------------------------
// Provider registry snapshot
// ---------------------------------------------------------------------------

/** A point-in-time snapshot of all registered provider adapters. */
type AdapterRegistrySnapshot = {
  capturedAt: number
  totalAdapters: number
  activeAdapters: string[]
  degradedAdapters: string[]
  offlineAdapters: string[]
}

// ---------------------------------------------------------------------------
// Credential-rotation types
// ---------------------------------------------------------------------------

/** Outcome of a credential-rotation attempt for a provider adapter. */
type CredentialRotationResult =
  | { rotated: true; newCredentialHash: string; rotatedAt: number }
  | { rotated: false; blockedReason: string }

/** Metadata attached to a managed credential entry. */
type ManagedCredentialEntry = {
  providerId: string
  credentialHash: string
  issuedAt: number
  expiresAt?: number
  rotationEnabled: boolean
  lastRotatedAt?: number
}

// ---------------------------------------------------------------------------
// Telemetry span types
// ---------------------------------------------------------------------------

/** An OpenTelemetry-style span covering a single provider round-trip. */
type ProviderTelemetrySpan = {
  spanId: string
  parentSpanId?: string
  operationName: string
  startEpochMs: number
  endEpochMs: number
  statusCode: 'ok' | 'unset' | 'err'
  attributeMap: Record<string, string | number | boolean>
}
