import { db } from '@crewmeld/db'
import { modelConfigs } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { decryptConfig } from '@/lib/connectors/encryption'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { testModelConnection } from '@/lib/models/tester'
import { resolveCodingProtocol } from '@/lib/models/coding-protocol'
import { getAllProviders } from '@/providers/registry'

const logger = createLogger('ModelsTestAPI')

async function _POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('model:test')
    if (auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const [config] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id))
    if (!config) {
      return apiErr('api.model.notFound', { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { model: overrideModel } = body

    const apiKey = config.apiKeyEncrypted ? decryptConfig(config.apiKeyEncrypted) : undefined
    const providers = getAllProviders()
    const provider = providers[config.providerId as keyof typeof providers]
    const defaultModel = provider?.defaultModel ?? ''
    const testModel = overrideModel ?? config.modelName ?? defaultModel

    if (!testModel) {
      return apiErr('api.model.testModelMissing', { status: 400 })
    }

    logger.info('Starting model test', { id, providerId: config.providerId, model: testModel })

    const locale = resolveLocale(request)
    const lang = locale === 'en' ? 'en' : 'zh'
    const result = await testModelConnection(
      config.providerId,
      apiKey,
      testModel,
      config.apiEndpoint ?? undefined,
      lang,
      resolveCodingProtocol(config.providerId, config.apiEndpoint)
    )

    // Prefix lastTestResult with stable marker so list-filter doesn't need
    // to string-match against localized messages.
    const prefix = result.success ? '[OK]' : '[FAIL]'
    await db
      .update(modelConfigs)
      .set({
        lastTestedAt: new Date(),
        lastTestResult: `${prefix} ${result.message}`,
        lastTestLatencyMs: result.latencyMs,
        updatedAt: new Date(),
      })
      .where(eq(modelConfigs.id, id))

    return apiOk({
      success: result.success,
      message: result.message,
      latencyMs: result.latencyMs,
      responsePreview: result.responsePreview,
      model: result.model,
      tokens: result.tokens,
    })
  } catch (error) {
    logger.error('Model test endpoint error', error)
    return apiErr('api.model.testFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
