import { promises as fs } from 'fs'
import path from 'path'
import { db } from '@crewmeld/db'
import { modelConfigs } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { decryptConfig } from '@/lib/connectors/encryption'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { logModelUsage } from '@/lib/models/usage-logger'
import {
  formatFixUserMessage,
  formatRefineUserMessage,
  getToolGenerateSystemPrompt,
  type ToolGenerateRole,
} from '@/lib/prompts/tool-generate'
import type { StreamingExecution } from '@/lib/types/execution'
import { checkSecurity } from '@/app/(employee)/skills/security-check'
import type { Locale } from '@/locales'
import { getProviderExecutor } from '@/providers/registry'
import type { ProviderId, ProviderResponse } from '@/providers/types'

const logger = createLogger('ToolGenerateAPI')

// ---------------------------------------------------------------------------
// Load spec files from specs/ directory and inject into LLM system prompt
// ---------------------------------------------------------------------------

const SPECS_DIR = path.join(process.cwd(), 'app/(employee)/skills/specs')

async function loadSpec(filename: string): Promise<string> {
  try {
    return await fs.readFile(path.join(SPECS_DIR, filename), 'utf-8')
  } catch {
    logger.warn(`Failed to read spec file ${filename}, using built-in default`)
    return ''
  }
}

async function buildSystemPrompt(locale: Locale, role: ToolGenerateRole): Promise<string> {
  const [codeSpec, securitySpec, inputReqSpec] = await Promise.all([
    loadSpec('code-generation.md'),
    loadSpec('security-check.md'),
    loadSpec('input-requirements.md'),
  ])
  return getToolGenerateSystemPrompt(locale, role, { codeSpec, securitySpec, inputReqSpec })
}

async function callModel(
  modelId: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const [config] = await db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.id, modelId), eq(modelConfigs.isActive, true)))

  if (!config) {
    throw new Error(
      'Model config does not exist or is not active; please configure and activate a model in System Connections - Model Configs first'
    )
  }

  const apiKey = config.apiKeyEncrypted ? decryptConfig(config.apiKeyEncrypted) : undefined
  const provider = await getProviderExecutor(config.providerId as ProviderId)

  if (!provider) {
    throw new Error(`Provider "${config.providerId}" is not in the registry`)
  }

  const { temperature, maxTokens } =
    (config.defaultParams as { temperature?: number; maxTokens?: number }) ?? {}
  const modelName = config.modelName ?? provider.defaultModel

  if (!modelName) {
    throw new Error('Model name is not configured')
  }

  const response = await provider.executeRequest({
    model: modelName,
    apiKey,
    systemPrompt,
    messages: [{ role: 'user' as const, content: userMessage }],
    temperature: temperature ?? 0.3,
    maxTokens: maxTokens ?? 16384,
    ...(config.apiEndpoint ? { apiEndpoint: config.apiEndpoint } : {}),
  })

  // Log model usage
  if (
    !(response instanceof ReadableStream) &&
    !('stream' in (response as unknown as Record<string, unknown>))
  ) {
    const providerResp = response as ProviderResponse
    logModelUsage({
      provider: config.providerId,
      model: providerResp.model || modelName,
      response: providerResp,
    })
  } else {
    logModelUsage({ provider: config.providerId, model: modelName })
  }

  if (response instanceof ReadableStream) {
    const reader = response.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    let done = false
    while (!done) {
      const { value, done: d } = await reader.read()
      done = d
      if (value) {
        const text = decoder.decode(value, { stream: !done })
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) chunks.push(content)
            } catch {
              // skip unparseable lines
            }
          }
        }
      }
    }
    return chunks.join('')
  }

  if ('stream' in (response as StreamingExecution)) {
    const streaming = response as StreamingExecution
    const reader = streaming.stream.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    let done = false
    while (!done) {
      const { value, done: d } = await reader.read()
      done = d
      if (value) {
        const text = decoder.decode(value, { stream: !done })
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) chunks.push(content)
            } catch {
              // skip unparseable lines
            }
          }
        }
      }
    }
    return chunks.join('')
  }

  const providerResponse = response as ProviderResponse
  return providerResponse.content
}

function parseModelOutput(raw: string): {
  title: string
  description: string
  parameters: Record<string, unknown>
  code: string
  language?: 'javascript' | 'python'
  fixExplanation?: string
  /**
   * File handling mode flag declared by the LLM in the JSON output.
   * true → SOP workspace mount mode (reads /workspace/inputs, writes
   * /workspace/outputs). Defaults to false on the consumer side, so
   * omitting the field keeps legacy boto3 behavior.
   */
  needsFileMount?: boolean
} {
  let cleaned = raw.trim()
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  const parsed = JSON.parse(cleaned)
  if (!parsed.title || !parsed.code) {
    throw new Error('Invalid model output format: missing title or code')
  }
  return parsed
}

/**
 * POST /api/employee/tools/generate
 *
 * Body:
 * - action: 'generate' | 'fix' | 'refine'
 * - modelId: string (model config ID)
 * - description?: string (for generate)
 * - tool?: { title, description, parameters, code } (for fix / refine)
 * - error?: string (for fix)
 * - instruction?: string (for refine — user's modification request)
 * - testParams?: Record<string, unknown> (for fix, the params used during test)
 */
async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('skill:create')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = await request.json()
    const { action, modelId } = body

    if (!modelId) {
      return apiErr('api.tool.modelRequired', { status: 400 })
    }

    const locale = resolveLocale(request)

    if (action === 'generate') {
      const { description } = body
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return apiErr('api.tool.descriptionRequired', { status: 400 })
      }

      logger.info('Generate tool request', {
        modelId,
        descriptionLength: description.length,
        locale,
      })

      const systemPrompt = await buildSystemPrompt(locale, 'generate')
      const raw = await callModel(modelId, systemPrompt, description.trim())
      const tool = parseModelOutput(raw)

      // Security check
      const paramNames = Object.keys(tool.parameters?.properties ?? {})
      const security = checkSecurity(tool.code, paramNames, tool.language ?? 'javascript')

      return apiOk(tool, { extra: { security } })
    }

    if (action === 'fix') {
      const { tool, error: errorMsg } = body
      if (!tool || !errorMsg) {
        return apiErr('api.tool.toolInfoRequired', { status: 400 })
      }

      logger.info('Fix tool request', { modelId, title: tool.title, locale })

      const userMessage = formatFixUserMessage(locale, tool, errorMsg)

      const systemPrompt = await buildSystemPrompt(locale, 'fix')
      const raw = await callModel(modelId, systemPrompt, userMessage)
      const fixed = parseModelOutput(raw)

      const paramNames = Object.keys(fixed.parameters?.properties ?? {})
      const security = checkSecurity(fixed.code, paramNames, fixed.language ?? 'javascript')

      return apiOk(fixed, { extra: { security } })
    }

    if (action === 'refine') {
      const { tool, instruction } = body
      if (
        !tool ||
        !instruction ||
        typeof instruction !== 'string' ||
        instruction.trim().length === 0
      ) {
        return apiErr('api.tool.instructionRequired', { status: 400 })
      }

      logger.info('Optimize tool request', { modelId, title: tool.title, locale })

      const userMessage = formatRefineUserMessage(locale, tool, instruction)

      const systemPrompt = await buildSystemPrompt(locale, 'refine')
      const raw = await callModel(modelId, systemPrompt, userMessage)
      const refined = parseModelOutput(raw)

      const paramNames = Object.keys(refined.parameters?.properties ?? {})
      const security = checkSecurity(refined.code, paramNames, refined.language ?? 'javascript')

      return apiOk(refined, { extra: { security } })
    }

    return apiErr('api.tool.actionUnknown', { status: 400, params: { action } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Tool generation/fix failed', { error: msg })
    return apiErr('api.tool.generateFailed', { status: 500, extra: { detail: msg } })
  }
}

export const POST = withAudit(_POST)
