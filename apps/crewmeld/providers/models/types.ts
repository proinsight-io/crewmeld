import type React from 'react'
import type { ModelPricing } from '@/providers/types'

/** Capability metadata for a specific model. */
export interface ModelCapabilities {
  temperature?: {
    min: number
    max: number
  }
  toolUsageControl?: boolean
  computerUse?: boolean
  nativeStructuredOutputs?: boolean
  /** Maximum supported output tokens for this model */
  maxOutputTokens?: number
  reasoningEffort?: {
    values: string[]
  }
  verbosity?: {
    values: string[]
  }
  thinking?: {
    levels: string[]
    default?: string
  }
  deepResearch?: boolean
  /** Whether this model supports conversation memory. Defaults to true if omitted. */
  memory?: boolean
}

/** Full definition of a single model including pricing and capabilities. */
export interface ModelDefinition {
  id: string
  pricing: ModelPricing
  capabilities: ModelCapabilities
  contextWindow?: number
}

/** Full definition of a provider including its model list and UI metadata. */
export type ProviderCategory = 'chat' | 'coding'

export interface ProviderDefinition {
  id: string
  name: string
  description: string
  models: ModelDefinition[]
  defaultModel: string
  modelPatterns?: RegExp[]
  icon?: React.ComponentType<{ className?: string }>
  capabilities?: ModelCapabilities
  contextInformationAvailable?: boolean
  category?: ProviderCategory
}
