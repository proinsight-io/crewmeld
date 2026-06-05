/**
 * Provider registry: builds and exports the live map of ProviderMetadata objects,
 * and exposes lookup helpers consumed throughout the app.
 */
import {
  getComputerUseModels,
  getProviderDefaultModel as getProviderDefaultModelFromDefinitions,
  getProviderModels as getProviderModelsFromDefinitions,
  PROVIDER_DEFINITIONS,
  updateOllamaModels as updateOllamaModelsInDefinitions,
} from '@/providers/models'
import type { ProviderId } from '@/providers/types'
import type { ProviderMetadata } from './metadata'

function buildProviderMetadata(providerId: ProviderId): ProviderMetadata {
  const def = PROVIDER_DEFINITIONS[providerId]
  return {
    id: providerId,
    name: def?.name || providerId,
    description: def?.description || '',
    version: '1.0.0',
    models: getProviderModelsFromDefinitions(providerId),
    defaultModel: getProviderDefaultModelFromDefinitions(providerId),
    modelPatterns: def?.modelPatterns,
  }
}

export const providers: Record<ProviderId, ProviderMetadata> = {
  ollama: buildProviderMetadata('ollama'),
  vllm: buildProviderMetadata('vllm'),
  openai: {
    ...buildProviderMetadata('openai'),
    computerUseModels: ['computer-use-preview'],
  },
  anthropic: {
    ...buildProviderMetadata('anthropic'),
    computerUseModels: getComputerUseModels().filter((model) =>
      getProviderModelsFromDefinitions('anthropic').includes(model)
    ),
  },
  google: buildProviderMetadata('google'),
  deepseek: buildProviderMetadata('deepseek'),
  qwen: buildProviderMetadata('qwen'),
  ernie: buildProviderMetadata('ernie'),
  hunyuan: buildProviderMetadata('hunyuan'),
  moonshot: buildProviderMetadata('moonshot'),
  zhipu: buildProviderMetadata('zhipu'),
  doubao: buildProviderMetadata('doubao'),
  minimax: buildProviderMetadata('minimax'),
  // Coding-specialized providers (dev-studio model selector / category=coding).
  'claude-coding': buildProviderMetadata('claude-coding'),
  'kimi-coding': buildProviderMetadata('kimi-coding'),
  'qianfan-coding': buildProviderMetadata('qianfan-coding'),
  'qwen-coding': buildProviderMetadata('qwen-coding'),
}

export function updateOllamaProviderModels(models: string[]): void {
  updateOllamaModelsInDefinitions(models)
  providers.ollama.models = getProviderModelsFromDefinitions('ollama')
}

export function updateVLLMProviderModels(models: string[]): void {
  const { updateVLLMModels } = require('@/providers/models')
  updateVLLMModels(models)
  providers.vllm.models = getProviderModelsFromDefinitions('vllm')
}

import { isModelBlacklisted, isProviderBlacklisted } from './blacklist'

export function getBaseModelProviders(): Record<string, ProviderId> {
  const allProviders = Object.entries(providers)
    .filter(([providerId]) => providerId !== 'ollama' && providerId !== 'vllm')
    .reduce(
      (map, [providerId, config]) => {
        config.models.forEach((model) => {
          map[model.toLowerCase()] = providerId as ProviderId
        })
        return map
      },
      {} as Record<string, ProviderId>
    )

  const filtered: Record<string, ProviderId> = {}
  for (const [model, providerId] of Object.entries(allProviders)) {
    if (isProviderBlacklisted(providerId)) continue
    if (!isModelBlacklisted(model)) filtered[model] = providerId
  }
  return filtered
}

export function getAllModelProviders(): Record<string, ProviderId> {
  return Object.entries(providers).reduce(
    (map, [providerId, config]) => {
      config.models.forEach((model) => {
        map[model.toLowerCase()] = providerId as ProviderId
      })
      return map
    },
    {} as Record<string, ProviderId>
  )
}

import { createLogger } from '@crewmeld/logger'

const registryLogger = createLogger('ProviderRegistry')

export function getProviderFromModel(model: string): ProviderId {
  const normalizedModel = model.toLowerCase()
  let providerId: ProviderId | null = null

  if (normalizedModel in getAllModelProviders()) {
    providerId = getAllModelProviders()[normalizedModel]
  } else {
    for (const [id, config] of Object.entries(providers)) {
      if (config.modelPatterns) {
        for (const pattern of config.modelPatterns) {
          if (pattern.test(normalizedModel)) {
            providerId = id as ProviderId
            break
          }
        }
      }
      if (providerId) break
    }
  }

  if (!providerId) {
    registryLogger.warn(`No provider found for model: ${model}, defaulting to ollama`)
    providerId = 'ollama'
  }

  if (isProviderBlacklisted(providerId)) {
    throw new Error(`Provider "${providerId}" is not available`)
  }

  if (isModelBlacklisted(normalizedModel)) {
    throw new Error(`Model "${model}" is not available`)
  }

  return providerId
}

export function getProvider(id: string): ProviderMetadata | undefined {
  const providerId = id.split('/')[0] as ProviderId
  return providers[providerId]
}

export function getProviderConfigFromModel(model: string): ProviderMetadata | undefined {
  const providerId = getProviderFromModel(model)
  return providers[providerId]
}

export function getAllModels(): string[] {
  return Object.values(providers).flatMap((provider) => provider.models || [])
}

export function getAllProviderIds(): ProviderId[] {
  return Object.keys(providers) as ProviderId[]
}

export function getProviderModels(providerId: ProviderId): string[] {
  return getProviderModelsFromDefinitions(providerId)
}
