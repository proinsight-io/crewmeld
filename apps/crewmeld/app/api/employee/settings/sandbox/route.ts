import { db } from '@crewmeld/db'
import { platformSettings } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  getSandboxSettings,
  SANDBOX_KEY_TO_FIELD,
  SANDBOX_SETTING_KEYS,
  validateSandboxSettings,
  type EgressMode,
  type SandboxSettingKey,
} from '@/lib/sandbox/settings'

export const dynamic = 'force-dynamic'

const logger = createLogger('SandboxSettingsAPI')

/** GET /api/employee/settings/sandbox -- read all sandbox settings */
export async function GET() {
  try {
    const auth = await requirePermission('sandbox:view')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }
    const settings = await getSandboxSettings()
    return apiOk(settings)
  } catch (error) {
    logger.error('Failed to fetch sandbox settings', error)
    return apiErr('api.setting.fetchSandboxFailed', { status: 500 })
  }
}

/** PATCH /api/employee/settings/sandbox -- update one or more fields */
async function _PATCH(request: NextRequest) {
  try {
    const auth = await requirePermission('sandbox:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = (await request.json()) as Record<string, unknown>

    // Coerce incoming arrays — values stored as JSONB arrays of strings.
    const normalized: {
      presetPythonPackages?: string[]
      allowedIps?: string[]
      allowedDomains?: string[]
      egressMode?: EgressMode
    } = {}

    if ('presetPythonPackages' in body) {
      normalized.presetPythonPackages = sanitizeStringArray(body.presetPythonPackages)
    }
    if ('allowedIps' in body) {
      normalized.allowedIps = sanitizeStringArray(body.allowedIps)
    }
    if ('allowedDomains' in body) {
      normalized.allowedDomains = sanitizeStringArray(body.allowedDomains)
    }
    if ('egressMode' in body) {
      const m = String(body.egressMode)
      normalized.egressMode = m === 'allowlist' ? 'allowlist' : 'unrestricted'
    }

    const validation = validateSandboxSettings(normalized)
    if (!validation.ok) {
      return apiErr('api.setting.sandboxInvalid', {
        status: 400,
        extra: { errors: validation.errors },
      })
    }

    const fieldToKey: Record<string, SandboxSettingKey> = {}
    for (const k of SANDBOX_SETTING_KEYS) {
      fieldToKey[SANDBOX_KEY_TO_FIELD[k]] = k
    }

    const updates: Array<{ key: SandboxSettingKey; value: unknown }> = []
    for (const [field, value] of Object.entries(normalized)) {
      const key = fieldToKey[field]
      if (key) updates.push({ key, value })
    }

    if (updates.length === 0) {
      return apiErr('api.setting.noValidFields', { status: 400 })
    }

    for (const { key, value } of updates) {
      await db
        .insert(platformSettings)
        .values({
          key,
          value,
          updatedAt: new Date(),
          updatedBy: auth.userId ?? null,
        })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: {
            value,
            updatedAt: new Date(),
            updatedBy: auth.userId ?? null,
          },
        })
    }

    logger.info('Sandbox settings updated', {
      updates: updates.map((u) => u.key),
      updatedBy: auth.userId,
    })

    return apiOk(null)
  } catch (error) {
    logger.error('Failed to update sandbox settings', error)
    return apiErr('api.setting.updateSandboxFailed', { status: 500 })
  }
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

export const PATCH = withAudit(_PATCH)
