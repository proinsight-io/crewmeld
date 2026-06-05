/**
 * Resolve LLM credentials for dev-studio container injection.
 *
 * A dev session may pin a specific coding model via `modelConfigId` (a row in
 * `model_configs` managed on the /connections page). When set, the row's
 * encrypted API key is decrypted and turned into the `ANTHROPIC_*` env the
 * claude-code-webui container expects. When null, we fall back to the global
 * `ANTHROPIC_*` env vars so self-hosted deployments without a configured model
 * keep working (Sub-spec C decision D2).
 *
 * @see docs/superpowers/specs/2026-05-26-tool-dev-studio-spec-C-design.md §4.1
 */
import { db } from '@crewmeld/db'
import { modelConfigs } from '@crewmeld/db/schema'
import { eq } from 'drizzle-orm'
import { decryptConfig } from '@/lib/connectors/encryption'
import { getProviderDefaultModel, PROVIDER_DEFINITIONS } from '@/providers/models'
import { getDevStudioEnv } from './env'

/**
 * Container env derived from a model selection. Mirrors the variables
 * claude-code-webui reads on startup, plus a human-readable label for the UI.
 */
export interface ResolvedModelEnv {
  ANTHROPIC_AUTH_TOKEN: string
  ANTHROPIC_BASE_URL: string
  ANTHROPIC_MODEL: string
  ANTHROPIC_SMALL_FAST_MODEL: string
  /** Display name for the header / session list (e.g. "Claude 编程 / claude-4-sonnet"). */
  displayLabel: string
}

// Mirrors the defaults declared in env.ts's EnvSchema. Used as the last-resort
// fallback when a pinned model_config omits apiEndpoint / modelName.
const DEFAULT_BASE_URL = 'https://qianfan.baidubce.com/anthropic/coding'
const DEFAULT_MODEL = 'qianfan-code-latest'

/**
 * Resolve the container env for a session's selected model.
 *
 * Priority:
 *  1. `modelConfigId` set → decrypt the matching `model_configs` row.
 *  2. `modelConfigId` null → global `ANTHROPIC_*` env fallback.
 *  3. Neither yields a token → throw.
 *
 * @throws when the config is missing/disabled/keyless, or when the fallback
 *   path has no `ANTHROPIC_AUTH_TOKEN` configured.
 */
export async function resolveModelEnv(modelConfigId: string | null): Promise<ResolvedModelEnv> {
  if (modelConfigId) {
    const rows = await db.select().from(modelConfigs).where(eq(modelConfigs.id, modelConfigId))
    const config = rows[0]
    if (!config) {
      throw new Error(`Model config not found: ${modelConfigId}`)
    }
    if (!config.isActive) {
      throw new Error(`Model config is disabled: ${modelConfigId}`)
    }
    if (!config.apiKeyEncrypted) {
      throw new Error(`Model config has no API key: ${modelConfigId}`)
    }

    const apiKey = decryptConfig(config.apiKeyEncrypted)
    const baseUrl = config.apiEndpoint || DEFAULT_BASE_URL
    const model = config.modelName || getProviderDefaultModel(config.providerId) || DEFAULT_MODEL
    const providerName = PROVIDER_DEFINITIONS[config.providerId]?.name ?? config.providerId

    return {
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      displayLabel: `${providerName} / ${model}`,
    }
  }

  // Fallback: global env (D2). ANTHROPIC_AUTH_TOKEN is optional in env.ts, so a
  // missing token here means the deployment has neither a configured model nor
  // a global key — surface that as a clear error rather than spawning a
  // container that can't authenticate.
  const env = getDevStudioEnv()
  if (!env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      'No model configured: set ANTHROPIC_AUTH_TOKEN or select a model for this session'
    )
  }
  return {
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: env.ANTHROPIC_SMALL_FAST_MODEL ?? env.ANTHROPIC_MODEL,
    displayLabel: '系统默认',
  }
}
