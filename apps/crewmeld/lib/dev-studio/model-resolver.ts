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
import type { ModelDefaultParams } from '@/lib/models/types'
import { getProviderDefaultModel, PROVIDER_DEFINITIONS } from '@/providers/models'
import { getDevStudioEnv } from './env'

/**
 * Container env derived from a model selection. Mirrors the variables
 * claude-code-webui reads on startup, plus a human-readable label for the UI.
 */
export interface ResolvedModelEnv {
  /**
   * The model_configs id this resolution actually landed on, or null when the
   * global `ANTHROPIC_*` env was used (no row backs it). This is the EFFECTIVE
   * id — when a null input falls back to an auto-picked coding config, this is
   * the picked config's id, NOT the null input. Callers persist this on the
   * session row so the header model selector can display the real model.
   */
  modelConfigId: string | null
  ANTHROPIC_AUTH_TOKEN: string
  ANTHROPIC_BASE_URL: string
  ANTHROPIC_MODEL: string
  ANTHROPIC_SMALL_FAST_MODEL: string
  /**
   * Optional Claude tier overrides sourced from a pinned model_config's
   * defaultParams. Undefined → the caller omits the env var entirely so the
   * sandbox image's Dockerfile default applies. `codingFastModel` drives both
   * SMALL_FAST (above) and HAIKU.
   */
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  /** Display name for the header / session list (e.g. "Claude 编程 / claude-4-sonnet"). */
  displayLabel: string
}

// Mirrors the defaults declared in env.ts's EnvSchema. Used as the last-resort
// fallback when a pinned model_config omits apiEndpoint / modelName.
const DEFAULT_BASE_URL = 'https://qianfan.baidubce.com/anthropic/coding'
const DEFAULT_MODEL = 'qianfan-code-latest'

type ModelConfigRow = typeof modelConfigs.$inferSelect

/**
 * Build the container env from a `model_configs` row. The row MUST have a
 * non-null `apiKeyEncrypted` (callers check this so they can emit a precise
 * error first).
 */
function buildEnvFromConfig(config: ModelConfigRow): ResolvedModelEnv {
  if (!config.apiKeyEncrypted) {
    throw new Error(`Model config has no API key: ${config.id}`)
  }
  const apiKey = decryptConfig(config.apiKeyEncrypted)
  const baseUrl = config.apiEndpoint || DEFAULT_BASE_URL
  const model = config.modelName || getProviderDefaultModel(config.providerId) || DEFAULT_MODEL
  const providerName = PROVIDER_DEFINITIONS[config.providerId]?.name ?? config.providerId

  // Optional Claude tier overrides. `codingFastModel` (UI "快速模型") sets both
  // SMALL_FAST and HAIKU; SONNET/OPUS map 1:1. Empty/undefined → the env var
  // is omitted so the sandbox image default applies. SMALL_FAST keeps its
  // legacy fallback to the main model when no override is supplied.
  const params = (config.defaultParams ?? {}) as ModelDefaultParams
  const fastModel = params.codingFastModel?.trim() || undefined
  const sonnetModel = params.codingSonnetModel?.trim() || undefined
  const opusModel = params.codingOpusModel?.trim() || undefined

  return {
    modelConfigId: config.id,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: fastModel ?? model,
    ...(fastModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel } : {}),
    ...(sonnetModel ? { ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel } : {}),
    ...(opusModel ? { ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel } : {}),
    displayLabel: `${providerName} / ${model}`,
  }
}

/**
 * Pick the most recently-updated active coding model_config that has a key.
 * Used as the last-resort fallback when a session has no pinned model and the
 * deployment has no global `ANTHROPIC_AUTH_TOKEN` (the common state now that
 * the .env model is deprecated in favor of configured coding models).
 */
async function pickFallbackCodingConfig(): Promise<ModelConfigRow | null> {
  const rows = await db.select().from(modelConfigs).where(eq(modelConfigs.isActive, true))
  const coding = rows
    .filter((r) => r.apiKeyEncrypted && PROVIDER_DEFINITIONS[r.providerId]?.category === 'coding')
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
  return coding[0] ?? null
}

/**
 * Resolve the container env for a session's selected model.
 *
 * Priority:
 *  1. `modelConfigId` set → decrypt the matching `model_configs` row.
 *  2. `modelConfigId` null + global `ANTHROPIC_AUTH_TOKEN` set → global env.
 *  3. `modelConfigId` null + no global token → auto-pick a recent active coding
 *     model_config (so removing the .env model still works).
 *  4. None of the above → throw.
 *
 * @throws when the config is missing/disabled/keyless, or when neither a global
 *   token nor any active coding model is available.
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
    return buildEnvFromConfig(config)
  }

  // No pinned model. Prefer the global env when a token is configured (keeps
  // .env-based deployments working, D2). ANTHROPIC_AUTH_TOKEN is optional in
  // env.ts, so it may be absent.
  const env = getDevStudioEnv()
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return {
      modelConfigId: null,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: env.ANTHROPIC_SMALL_FAST_MODEL ?? env.ANTHROPIC_MODEL,
      displayLabel: '系统默认',
    }
  }

  // Safety net: no global token → auto-pick a configured coding model so the
  // entry flow still works when the operator removed the .env ANTHROPIC_*.
  const fallback = await pickFallbackCodingConfig()
  if (fallback) {
    return buildEnvFromConfig(fallback)
  }

  throw new Error(
    'No coding model configured: enable a coding model on the connections page, or set ANTHROPIC_AUTH_TOKEN'
  )
}
