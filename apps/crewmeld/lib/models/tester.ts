import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import type { ModelTestResult } from '@/lib/models/types'
import { logModelUsage } from '@/lib/models/usage-logger'
import type { StreamingExecution } from '@/lib/types/execution'
import { PROVIDER_DEFINITIONS } from '@/providers/models'
import { getProviderExecutor } from '@/providers/registry'
import type { ProviderId, ProviderResponse } from '@/providers/types'

const logger = createLogger('ModelTester')

const TEST_TIMEOUT_MS = 30_000

/** Stable Anthropic Messages API version pin sent on every coding test ping. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Minimal shape of an Anthropic Messages API success response. */
interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** True when the provider is a coding-category provider (dev-studio Claude Code). */
function isCodingProvider(providerId: string): boolean {
  return PROVIDER_DEFINITIONS[providerId]?.category === 'coding'
}

/**
 * Heuristic: does this endpoint speak the Anthropic Messages protocol?
 * Coding endpoints split into OpenAI-compatible (Kimi /v1, Qwen
 * /compatible-mode/v1) and Anthropic-compatible (Qianfan /anthropic/coding,
 * DashScope /apps/anthropic, official api.anthropic.com). Only the latter can
 * be tested via /v1/messages — the former stay on the OpenAI-compat path.
 */
function isAnthropicEndpoint(url?: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.hostname === 'api.anthropic.com') return true
    return /\/anthropic(\/|$)/i.test(u.pathname)
  } catch {
    return /\/anthropic(\/|$)/i.test(url)
  }
}

/**
 * Builds the `{base}/v1/messages` URL, collapsing a trailing `/v1` so an
 * endpoint like `https://api.anthropic.com/v1` does not become `/v1/v1`.
 */
function buildMessagesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '')
  return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

/**
 * Test model connection for a specified provider
 */
export async function testModelConnection(
  providerId: string,
  apiKey: string | undefined,
  model: string,
  apiEndpoint?: string,
  lang: 'zh' | 'en' = 'zh'
): Promise<ModelTestResult> {
  const startTime = Date.now()
  const testPrompt = t('modelTestHello', lang)

  // Coding providers on an Anthropic endpoint must be tested with the Anthropic
  // Messages protocol — the same path dev-studio's Claude Code uses. The
  // OpenAI-compat executor would POST /chat/completions and 404 against these
  // /anthropic endpoints. Kimi/Qwen on their OpenAI endpoints fall through to
  // the existing path below.
  if (isCodingProvider(providerId) && isAnthropicEndpoint(apiEndpoint)) {
    return testCodingAnthropic(apiKey, model, apiEndpoint as string, lang, startTime, testPrompt)
  }

  try {
    const provider = await getProviderExecutor(providerId as ProviderId)

    if (!provider) {
      return {
        success: false,
        message: t('modelTestNotRegistered', lang, { provider: providerId }),
        latencyMs: Date.now() - startTime,
        model,
      }
    }

    const request = {
      model,
      apiKey,
      messages: [{ role: 'user' as const, content: testPrompt }],
      maxTokens: 100,
      temperature: 0.1,
      ...(apiEndpoint ? { apiEndpoint } : {}),
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(t('modelTestTimeout', lang))), TEST_TIMEOUT_MS)
    )

    const response = await Promise.race([provider.executeRequest(request), timeoutPromise])

    const latencyMs = Date.now() - startTime

    if (response instanceof ReadableStream || 'stream' in (response as StreamingExecution)) {
      return {
        success: true,
        message: t('modelTestStreamSuccess', lang),
        latencyMs,
        model,
      }
    }

    const providerResponse = response as ProviderResponse

    logModelUsage({
      provider: providerId,
      model: providerResponse.model || model,
      response: providerResponse,
      durationMs: latencyMs,
    })

    return {
      success: true,
      message: t('modelTestSuccess', lang),
      latencyMs,
      responsePreview: providerResponse.content.slice(0, 200),
      model,
      tokens: providerResponse.tokens
        ? {
            input: providerResponse.tokens.input ?? 0,
            output: providerResponse.tokens.output ?? 0,
            total: providerResponse.tokens.total ?? 0,
          }
        : undefined,
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error('Model test failed', { providerId, model, error: errorMessage })

    return {
      success: false,
      message: t('modelTestFailed', lang, { error: errorMessage }),
      latencyMs,
      model,
    }
  }
}

/**
 * Test a coding provider whose endpoint speaks the Anthropic Messages protocol.
 *
 * Mirrors what dev-studio's Claude Code does: POST `{endpoint}/v1/messages`
 * with both `x-api-key` (official Anthropic) and `Authorization: Bearer`
 * (proxy gateways like Qianfan/DashScope) so a single request works across
 * official and compatible endpoints.
 */
async function testCodingAnthropic(
  apiKey: string | undefined,
  model: string,
  apiEndpoint: string,
  lang: 'zh' | 'en',
  startTime: number,
  testPrompt: string
): Promise<ModelTestResult> {
  if (!apiKey) {
    return {
      success: false,
      message: t('modelTestFailed', lang, { error: lang === 'en' ? 'Missing API Key' : '缺少 API Key' }),
      latencyMs: Date.now() - startTime,
      model,
    }
  }

  const url = buildMessagesUrl(apiEndpoint)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: testPrompt }],
      }),
      signal: controller.signal,
    })

    const latencyMs = Date.now() - startTime

    if (!res.ok) {
      const bodyText = (await res.text().catch(() => '')).slice(0, 200)
      return {
        success: false,
        message: t('modelTestFailed', lang, { error: `${res.status} ${bodyText || '(no body)'}` }),
        latencyMs,
        model,
      }
    }

    const data = (await res.json().catch(() => ({}))) as AnthropicMessageResponse
    const text = data.content?.find((block) => block.type === 'text')?.text ?? ''
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0

    return {
      success: true,
      message: t('modelTestSuccess', lang),
      latencyMs,
      responsePreview: text.slice(0, 200),
      model,
      tokens: data.usage
        ? { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }
        : undefined,
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage =
      error instanceof Error
        ? error.name === 'AbortError'
          ? t('modelTestTimeout', lang)
          : error.message
        : String(error)
    logger.error('Coding model test failed', { model, endpoint: apiEndpoint, error: errorMessage })
    return {
      success: false,
      message: t('modelTestFailed', lang, { error: errorMessage }),
      latencyMs,
      model,
    }
  } finally {
    clearTimeout(timer)
  }
}
