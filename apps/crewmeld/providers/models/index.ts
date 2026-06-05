import { chineseProviders } from '@/providers/models/chinese'
import { codingProviders } from '@/providers/models/coding'
import type {
  ModelCapabilities,
  ModelDefinition,
  ProviderCategory,
  ProviderDefinition,
} from '@/providers/models/types'
import { westernProviders } from '@/providers/models/western'
import type { ModelPricing } from '@/providers/types'

export type { ModelCapabilities, ModelDefinition, ProviderCategory, ProviderDefinition }

/** Combined registry of all provider definitions — single source of truth. */
export const PROVIDER_DEFINITIONS: Record<string, ProviderDefinition> = {
  ...westernProviders,
  ...chineseProviders,
  ...codingProviders,
}


// ---------------------------------------------------------------------------
// Provider / model lookup helpers
// ---------------------------------------------------------------------------

export function getProviderModels(providerId: string): string[] {
  return PROVIDER_DEFINITIONS[providerId]?.models.map((m) => m.id) || []
}

export function getProviderDefaultModel(providerId: string): string {
  return PROVIDER_DEFINITIONS[providerId]?.defaultModel || ''
}

export function getModelPricing(modelId: string): ModelPricing | null {
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    const model = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase())
    if (model) return model.pricing
  }
  return null
}

export function getModelCapabilities(modelId: string): ModelCapabilities | null {
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    const model = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase())
    if (model) return { ...provider.capabilities, ...model.capabilities }
  }
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    if (provider.modelPatterns) {
      for (const pattern of provider.modelPatterns) {
        if (pattern.test(modelId.toLowerCase())) return provider.capabilities || null
      }
    }
  }
  return null
}

export function getModelsWithTemperatureSupport(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.temperature) models.push(model.id)
    }
  }
  return models
}

export function getModelsWithTempRange01(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.temperature?.max === 1) models.push(model.id)
    }
  }
  return models
}

export function getModelsWithTempRange02(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.temperature?.max === 2) models.push(model.id)
    }
  }
  return models
}

export function getProvidersWithToolUsageControl(): string[] {
  const providers: string[] = []
  for (const [providerId, provider] of Object.entries(PROVIDER_DEFINITIONS)) {
    if (provider.capabilities?.toolUsageControl) providers.push(providerId)
  }
  return providers
}

export function getHostedModels(): string[] {
  return [
    ...getProviderModels('openai'),
    ...getProviderModels('anthropic'),
    ...getProviderModels('google'),
  ]
}

export function getComputerUseModels(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.computerUse) models.push(model.id)
    }
  }
  return models
}

export function supportsTemperature(modelId: string): boolean {
  return !!getModelCapabilities(modelId)?.temperature
}

export function getMaxTemperature(modelId: string): number | undefined {
  return getModelCapabilities(modelId)?.temperature?.max
}

export function supportsToolUsageControl(providerId: string): boolean {
  return getProvidersWithToolUsageControl().includes(providerId)
}

export function updateOllamaModels(models: string[]): void {
  PROVIDER_DEFINITIONS.ollama.models = models.map((modelId) => ({
    id: modelId,
    pricing: {
      input: 0,
      output: 0,
      updatedAt: new Date().toISOString().split('T')[0],
    },
    capabilities: {},
  }))
}

export function updateVLLMModels(models: string[]): void {
  PROVIDER_DEFINITIONS.vllm.models = models.map((modelId) => ({
    id: modelId,
    pricing: {
      input: 0,
      output: 0,
      updatedAt: new Date().toISOString().split('T')[0],
    },
    capabilities: {},
  }))
}

// ---------------------------------------------------------------------------
// Embedding model pricing
// ---------------------------------------------------------------------------

export const EMBEDDING_MODEL_PRICING: Record<string, ModelPricing> = {
  'text-embedding-3-small': {
    input: 0.02,
    output: 0.0,
    updatedAt: '2025-07-10',
  },
  'text-embedding-3-large': {
    input: 0.13,
    output: 0.0,
    updatedAt: '2025-07-10',
  },
  'text-embedding-ada-002': {
    input: 0.1,
    output: 0.0,
    updatedAt: '2025-07-10',
  },
}

export function getEmbeddingModelPricing(modelId: string): ModelPricing | null {
  return EMBEDDING_MODEL_PRICING[modelId] || null
}

// ---------------------------------------------------------------------------
// Reasoning effort helpers
// ---------------------------------------------------------------------------

export function getModelsWithReasoningEffort(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.reasoningEffort) models.push(model.id)
    }
  }
  return models
}

/**
 * Get the reasoning effort values for a specific model.
 * Returns null if the model does not support reasoning effort.
 */
export function getReasoningEffortValuesForModel(modelId: string): string[] | null {
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    const model = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase())
    if (model?.capabilities.reasoningEffort) return model.capabilities.reasoningEffort.values
  }
  return null
}

export function getModelsWithVerbosity(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.verbosity) models.push(model.id)
    }
  }
  return models
}

/**
 * Get the verbosity values for a specific model.
 * Returns null if the model does not support verbosity.
 */
export function getVerbosityValuesForModel(modelId: string): string[] | null {
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    const model = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase())
    if (model?.capabilities.verbosity) return model.capabilities.verbosity.values
  }
  return null
}

// ---------------------------------------------------------------------------
// Native structured outputs
// ---------------------------------------------------------------------------

/**
 * Check if a model supports native structured outputs.
 * Handles model IDs with date suffixes (e.g., claude-sonnet-4-5-20250514).
 */
export function supportsNativeStructuredOutputs(modelId: string): boolean {
  const normalizedModelId = modelId.toLowerCase()
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.nativeStructuredOutputs) {
        const baseModelId = model.id.toLowerCase()
        if (normalizedModelId === baseModelId || normalizedModelId.startsWith(`${baseModelId}-`)) {
          return true
        }
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Thinking / reasoning capability helpers
// ---------------------------------------------------------------------------

/**
 * Check if a model supports thinking/reasoning features.
 * Returns the thinking capability config if supported, null otherwise.
 */
export function getThinkingCapability(
  modelId: string
): { levels: string[]; default?: string } | null {
  const normalizedModelId = modelId.toLowerCase()
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.thinking) {
        const baseModelId = model.id.toLowerCase()
        if (normalizedModelId === baseModelId || normalizedModelId.startsWith(`${baseModelId}-`)) {
          return model.capabilities.thinking
        }
      }
    }
  }
  return null
}

/** Get all models that support thinking capability. */
export function getModelsWithThinking(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.thinking) models.push(model.id)
    }
  }
  return models
}

/**
 * Get the thinking levels for a specific model.
 * Returns null if the model does not support thinking.
 */
export function getThinkingLevelsForModel(modelId: string): string[] | null {
  return getThinkingCapability(modelId)?.levels ?? null
}

// ---------------------------------------------------------------------------
// Deep research helpers
// ---------------------------------------------------------------------------

/** Get all models that support deep research capability. */
export function getModelsWithDeepResearch(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.deepResearch) models.push(model.id)
    }
  }
  return models
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/**
 * Get all models that explicitly disable memory support (memory: false).
 * Models without this capability default to supporting memory.
 */
export function getModelsWithoutMemory(): string[] {
  const models: string[] = []
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.capabilities.memory === false) models.push(model.id)
    }
  }
  return models
}

// ---------------------------------------------------------------------------
// Max output tokens
// ---------------------------------------------------------------------------

/**
 * Get the max output tokens for a specific model.
 *
 * @param modelId - The model ID
 */
export function getMaxOutputTokensForModel(modelId: string): number {
  const normalizedModelId = modelId.toLowerCase()
  const STANDARD_MAX_OUTPUT_TOKENS = 4096
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      const baseModelId = model.id.toLowerCase()
      if (normalizedModelId === baseModelId || normalizedModelId.startsWith(`${baseModelId}-`)) {
        return model.capabilities.maxOutputTokens || STANDARD_MAX_OUTPUT_TOKENS
      }
    }
  }
  return STANDARD_MAX_OUTPUT_TOKENS
}
