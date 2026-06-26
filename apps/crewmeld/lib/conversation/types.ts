/**
 * Conversation engine core type definitions
 */

/**
 * Knowledge base chunk reference (shared type for frontend/backend, used by SSE events and UI)
 */
export interface KnowledgeChunkReference {
  chunkId: string
  documentId: string
  documentName: string
  similarity: number
  content: string
}

/**
 * SSE event types
 */
export type ConversationEventType =
  | 'message:start'
  | 'message:delta'
  | 'message:done'
  | 'message:files'
  | 'tool:start'
  | 'tool:result'
  | 'intent:classified'
  | 'knowledge:result'
  | 'progress'
  | 'error'

/**
 * SSE event structure
 */
export interface ConversationEvent {
  type: ConversationEventType
  data: Record<string, unknown>
}

/**
 * Model config (used after engine resolution)
 */
export interface ConversationModelConfig {
  providerId: string
  model: string
  apiKey: string
  baseUrl: string
  /**
   * User-defined passthrough parameters merged into the OpenAI-compatible
   * `/chat/completions` body (e.g. `enable_thinking: false`). Sourced from
   * `model_configs.default_params.extraParams`. Reserved request keys are
   * never overridden — see `mergeExtraParams` in `./model-config`.
   */
  extraParams?: Record<string, unknown>
}

/**
 * OpenAI-compatible tool_call structure
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Conversation error
 */
export interface ConversationError {
  code: string
  message: string
  details?: Record<string, unknown>
}

/**
 * Context window config
 */
export interface ContextWindowConfig {
  maxTokens: number
  reservedForResponse: number
  reservedForTools: number
}

/**
 * Workflow bridge execution result
 */
export interface WorkflowBridgeResult {
  success: boolean
  taskId: string
  output?: Record<string, unknown>
  outputSummary?: string
  errorMessage?: string
  status: 'success' | 'failed' | 'hitl_waiting'
}

/**
 * OpenAI-compatible message (for internal engine use)
 */
export interface EngineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

/**
 * OpenAI-compatible tool definition
 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/**
 * OpenAI-compatible chat completion chunk (streaming)
 */
export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
