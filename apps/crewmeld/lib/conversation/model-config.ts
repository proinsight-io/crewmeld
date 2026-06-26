/**
 * Model config resolution — get LLM credentials and base URL from employee config
 */

import { db, digitalEmployees, modelConfigs } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { getApiKeyWithBYOK } from '@/lib/api-key/byok'
import { decryptConfig } from '@/lib/connectors/encryption'
import { decryptSecret } from '@/lib/core/security/encryption'
import { t } from '@/lib/core/server-i18n'
import { getProviderFromModel } from '@/providers/utils'
import type { ConversationModelConfig } from './types'

const logger = createLogger('ConversationModelConfig')

/**
 * Request-body keys the engine controls. User-defined `extraParams` can never
 * overwrite these, preventing a misconfigured parameter from breaking the call.
 */
const RESERVED_BODY_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
])

/**
 * Merge user-defined `extraParams` into an OpenAI-compatible request body,
 * skipping reserved keys. Mutates and returns `body` for call-site convenience.
 *
 * @param body - The request body being assembled (e.g. for `/chat/completions`).
 * @param extraParams - Operator-configured passthrough params, may be undefined.
 */
export function mergeExtraParams(
  body: Record<string, unknown>,
  extraParams?: Record<string, unknown>
): Record<string, unknown> {
  if (!extraParams) return body
  for (const [key, value] of Object.entries(extraParams)) {
    if (RESERVED_BODY_KEYS.has(key)) continue
    body[key] = value
  }
  return body
}

/**
 * Provider -> OpenAI-compatible base URL mapping
 */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ernie: 'https://qianfan.baidubce.com/v2',
  hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  minimax: 'https://api.minimax.chat/v1',
}

/**
 * Resolve employee model config
 *
 * Priority: employee-bound model -> employee config.model -> system active model config -> throw error
 */
export async function resolveModelConfig(
  employeeId: string,
  workspaceId: string
): Promise<ConversationModelConfig> {
  // 1. Query employee config (with bound model ID)
  const [employee] = await db
    .select({
      config: digitalEmployees.config,
      modelConfigId: digitalEmployees.modelConfigId,
    })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, employeeId))
    .limit(1)

  if (!employee) {
    throw new Error(t('convModelNotFound', 'zh', { id: employeeId }))
  }

  // 2. Prefer employee-bound model config
  if (employee.modelConfigId) {
    const resolved = await resolveFromModelConfig(employee.modelConfigId, workspaceId)
    if (resolved) {
      logger.info(
        `Resolved model config (employee binding): provider=${resolved.providerId}, model=${resolved.model}`
      )
      return resolved
    }
  }

  const employeeConfig = employee.config as Record<string, unknown>
  const configModel = (employeeConfig.model as string) ?? ''

  // 3. If employee has model configured, use directly
  if (configModel) {
    const providerId = getProviderFromModel(configModel)
    const { apiKey } = await getApiKeyWithBYOK(providerId, configModel, workspaceId)
    const baseUrl = resolveBaseUrl(providerId, employeeConfig.apiEndpoint as string | undefined)

    logger.info(
      `Resolved model config (employee config): provider=${providerId}, model=${configModel}`
    )
    return { providerId, model: configModel, apiKey: apiKey ?? '', baseUrl }
  }

  // 4. Fall back to system active model config
  const [activeConfig] = await db
    .select({
      id: modelConfigs.id,
      providerId: modelConfigs.providerId,
      displayName: modelConfigs.displayName,
      modelName: modelConfigs.modelName,
      apiKeyEncrypted: modelConfigs.apiKeyEncrypted,
      apiEndpoint: modelConfigs.apiEndpoint,
      defaultParams: modelConfigs.defaultParams,
    })
    .from(modelConfigs)
    .where(eq(modelConfigs.isActive, true))
    .limit(1)

  if (!activeConfig) {
    // In E2E mock mode, synthesize a dummy config so MSW can intercept.
    if (process.env.E2E_MOCK_SERVER === '1') {
      logger.info('E2E mock mode: no active model config found, using deepseek stub')
      return {
        providerId: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'e2e-mock-key',
        baseUrl: 'https://api.deepseek.com/v1',
      }
    }
    throw new Error(t('convModelNoAvailable'))
  }

  return resolveFromModelConfigRow(activeConfig, workspaceId, 'system default')
}

/**
 * Resolve model config from model_configs table
 */
async function resolveFromModelConfig(
  modelConfigId: string,
  workspaceId: string
): Promise<ConversationModelConfig | null> {
  const [config] = await db
    .select({
      id: modelConfigs.id,
      providerId: modelConfigs.providerId,
      displayName: modelConfigs.displayName,
      modelName: modelConfigs.modelName,
      apiKeyEncrypted: modelConfigs.apiKeyEncrypted,
      apiEndpoint: modelConfigs.apiEndpoint,
      defaultParams: modelConfigs.defaultParams,
    })
    .from(modelConfigs)
    .where(eq(modelConfigs.id, modelConfigId))
    .limit(1)

  if (!config) {
    logger.warn(`Bound model config ${modelConfigId} not found, will fall back`)
    return null
  }

  return resolveFromModelConfigRow(config, workspaceId, 'employee binding')
}

/**
 * Resolve credentials from model config row
 */
async function resolveFromModelConfigRow(
  config: {
    id: string
    providerId: string
    displayName: string
    modelName: string | null
    apiKeyEncrypted: string | null
    apiEndpoint: string | null
    defaultParams: unknown
  },
  workspaceId: string,
  source: string
): Promise<ConversationModelConfig> {
  const providerId = config.providerId
  const model = config.modelName ?? config.displayName

  // Decrypt API Key
  let apiKey = ''
  if (config.apiKeyEncrypted) {
    try {
      apiKey = decryptConfig(config.apiKeyEncrypted)
    } catch {
      // Try another decryption method
      try {
        const { decrypted } = await decryptSecret(config.apiKeyEncrypted)
        apiKey = decrypted
      } catch {
        logger.warn(`API Key decryption failed for model config ${config.id}`)
      }
    }
  }

  if (!apiKey) {
    // In E2E mock mode MSW intercepts outbound HTTP, so no real key is needed.
    if (process.env.E2E_MOCK_SERVER === '1') {
      apiKey = 'e2e-mock-key'
    } else {
      // Try obtaining via BYOK
      try {
        const result = await getApiKeyWithBYOK(providerId, model, workspaceId)
        apiKey = result.apiKey ?? ''
      } catch {
        throw new Error(t('convModelNoApiKey', 'zh', { model: config.displayName }))
      }
    }
  }

  const baseUrl = resolveBaseUrl(providerId, config.apiEndpoint ?? undefined)

  const params = (config.defaultParams ?? {}) as { extraParams?: Record<string, unknown> }
  const extraParams =
    params.extraParams && typeof params.extraParams === 'object' ? params.extraParams : undefined

  logger.info(`Resolved model config (${source}): provider=${providerId}, model=${model}`)
  return { providerId, model, apiKey, baseUrl, extraParams }
}

function resolveBaseUrl(providerId: string, customEndpoint?: string): string {
  if (customEndpoint) return customEndpoint
  const baseUrl = PROVIDER_BASE_URLS[providerId]
  if (!baseUrl) {
    throw new Error(t('convModelUnsupportedProvider', 'zh', { provider: providerId }))
  }
  return baseUrl
}
