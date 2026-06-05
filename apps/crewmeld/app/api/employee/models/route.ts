import { db } from '@crewmeld/db'
import { modelConfigs } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { encryptConfig } from '@/lib/connectors/encryption'
import type { ModelDefaultParams, ProviderDisplayInfo } from '@/lib/models/types'
import { PROVIDER_DEFINITIONS } from '@/providers/models'
import { getAllProviders } from '@/providers/registry'

const logger = createLogger('ModelsAPI')

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session?.user?.id) {
      return apiErr('api.common.unauthorized', { status: 401 })
    }

    const url = new URL(request.url)
    const providerIdFilter = url.searchParams.get('providerId')
    const activeOnly = url.searchParams.get('activeOnly') === 'true'
    // Optional provider-category filter (e.g. ?category=coding for the
    // dev-studio model selector). Category lives on the provider definition,
    // not on the model_configs row, so it's applied in-memory below.
    const categoryFilter = url.searchParams.get('category')
    const inCategory = (providerId: string): boolean =>
      !categoryFilter || PROVIDER_DEFINITIONS[providerId]?.category === categoryFilter

    const filters = []
    if (providerIdFilter) {
      filters.push(eq(modelConfigs.providerId, providerIdFilter))
    }
    if (activeOnly) {
      filters.push(eq(modelConfigs.isActive, true))
    }

    const rows = await db
      .select()
      .from(modelConfigs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(modelConfigs.providerId)

    const providers = getAllProviders()

    const activeFilteredRows = activeOnly
      ? // `lastTestResult` is written with a `[OK]` / `[FAIL]` prefix by the
        // test route. Legacy rows without prefix are treated as untested (kept
        // in list). See apps/crewmeld/app/api/employee/models/[id]/test/route.ts.
        rows.filter((row) => !row.lastTestResult?.startsWith('[FAIL]'))
      : rows
    const filteredRows = activeFilteredRows.filter((row) => inCategory(row.providerId))

    const configs = filteredRows.map((row) => {
      const provider = providers[row.providerId as keyof typeof providers]
      return {
        id: row.id,
        providerId: row.providerId,
        displayName: row.displayName,
        modelName: row.modelName,
        apiEndpoint: row.apiEndpoint,
        hasApiKey: !!row.apiKeyEncrypted,
        defaultParams: row.defaultParams as ModelDefaultParams,
        isActive: row.isActive,
        lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
        lastTestResult: row.lastTestResult,
        lastTestLatencyMs: row.lastTestLatencyMs,
        createdAt: row.createdAt?.toISOString() ?? '',
        updatedAt: row.updatedAt?.toISOString() ?? '',
        providerMeta: provider
          ? {
              name: provider.name,
              description: provider.description,
              models: provider.models,
              defaultModel: provider.defaultModel,
            }
          : {
              name: row.providerId,
              description: '',
              models: [],
              defaultModel: '',
            },
      }
    })

    const configuredProviderIds = new Set(filteredRows.map((r) => r.providerId))
    const availableProviders: ProviderDisplayInfo[] = Object.entries(providers)
      .filter(([id]) => inCategory(id))
      .map(([id, p]) => {
      const matchingConfig = rows.find((r) => r.providerId === id)
      return {
        id,
        name: p.name,
        description: p.description,
        models: p.models,
        defaultModel: p.defaultModel,
        configured: configuredProviderIds.has(id),
        isActive: matchingConfig?.isActive ?? false,
        lastTestedAt: matchingConfig?.lastTestedAt?.toISOString() ?? null,
      }
    })

    return apiOk({ configs, availableProviders, total: configs.length })
  } catch (error) {
    logger.error('Failed to fetch model configs', error)
    return apiErr('api.model.fetchListFailed', { status: 500 })
  }
}

async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('model:create')
    if (auth.error) {
      return apiAuthErr(auth)
    }

    const body = await request.json()
    const { providerId, displayName, modelName, apiKey, apiEndpoint, defaultParams } = body

    if (!providerId || !displayName) {
      return apiErr('api.model.providerIdAndNameRequired', { status: 400 })
    }

    const providers = getAllProviders()
    if (!(providerId in providers)) {
      return apiErr('api.model.providerNotRegistered', {
        status: 400,
        params: { providerId },
      })
    }

    if (defaultParams) {
      if (
        defaultParams.temperature !== undefined &&
        (defaultParams.temperature < 0 || defaultParams.temperature > 2)
      ) {
        return apiErr('api.model.temperatureOutOfRange', { status: 400 })
      }
      if (defaultParams.maxTokens !== undefined && defaultParams.maxTokens < 1) {
        return apiErr('api.model.maxTokensInvalid', { status: 400 })
      }
    }

    const id = `mc_${nanoid(16)}`
    const mergedParams: ModelDefaultParams = {
      temperature: defaultParams?.temperature ?? 0.7,
      maxTokens: defaultParams?.maxTokens ?? 16384,
      ...(defaultParams?.topP !== undefined ? { topP: defaultParams.topP } : {}),
      ...(defaultParams?.presencePenalty !== undefined
        ? { presencePenalty: defaultParams.presencePenalty }
        : {}),
      ...(defaultParams?.frequencyPenalty !== undefined
        ? { frequencyPenalty: defaultParams.frequencyPenalty }
        : {}),
    }

    const apiKeyEncrypted = apiKey ? encryptConfig(apiKey) : null

    await db.insert(modelConfigs).values({
      id,
      providerId,
      displayName,
      modelName: modelName ?? null,
      apiKeyEncrypted,
      apiEndpoint: apiEndpoint ?? null,
      defaultParams: mergedParams,
      isActive: false,
    })

    logger.info('Model config created', { id, providerId })

    return apiOk(
      {
        id,
        providerId,
        displayName,
        isActive: false,
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error('Failed to create model config', error)
    return apiErr('api.model.createFailed', { status: 500 })
  }
}

export const POST = withAudit(_POST)
