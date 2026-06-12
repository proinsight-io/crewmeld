/**
 * POST /api/channels/dingtalk/webhook/[employeeId] — DingTalk event callback (multi-employee routing)
 *
 * Each digital employee has its own webhook URL.
 * employeeId comes from URL path parameter.
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { dingtalkPlugin } from '@/lib/channels/plugins/dingtalk'
import type { DingtalkPluginConfig } from '@/lib/channels/plugins/dingtalk/types'
import { handleChannelWebhook } from '@/lib/channels/webhook-handler'
import {
  resolveAllCredentialsByType,
  resolveCredentialByBoundEmployee,
} from '@/lib/connectors/resolver'

const logger = createLogger('DingtalkWebhook:Employee')

/**
 * Resolve the DingTalk plugin config for an employee.
 *
 * @returns The config plus the systemConnections row id that received the message
 *   (threaded downstream for SOP-visibility identity resolution), or null.
 */
async function resolveDingtalkConfig(
  employeeId: string
): Promise<{ config: DingtalkPluginConfig; connectionId: string } | null> {
  // Prefer the connection bound to the employee
  const bound = await resolveCredentialByBoundEmployee(employeeId, 'dingtalk')
  if (bound) {
    const c = bound.config
    return {
      config: {
        appKey: c.appKey ?? '',
        appSecret: c.appSecret ?? '',
        robotCode: c.robotCode,
        secret: c.secret ?? '',
        aesKey: c.aesKey,
        token: c.token,
        suiteKey: c.suiteKey ?? c.appKey,
        boundEmployeeId: employeeId,
      },
      connectionId: bound.connectionId,
    }
  }

  // Fallback: use the first available DingTalk connection
  const credentials = await resolveAllCredentialsByType('dingtalk')
  if (credentials.length > 0) {
    const c = credentials[0].config
    return {
      config: {
        appKey: c.appKey ?? '',
        appSecret: c.appSecret ?? '',
        robotCode: c.robotCode,
        secret: c.secret ?? '',
        aesKey: c.aesKey,
        token: c.token,
        suiteKey: c.suiteKey ?? c.appKey,
        boundEmployeeId: employeeId,
      },
      connectionId: credentials[0].connectionId,
    }
  }

  return null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params

  if (!employeeId) {
    return apiErr('api.channelWebhook.missingEmployeeId', { status: 400 })
  }

  const resolved = await resolveDingtalkConfig(employeeId)

  if (!resolved || (!resolved.config.secret && !resolved.config.appSecret)) {
    logger.warn('DingTalk webhook: no matching credentials', { employeeId })
    return apiErr('api.channelWebhook.dingtalkNotConfigured', { status: 500 })
  }

  const { config, connectionId } = resolved
  return handleChannelWebhook(request, {
    plugin: dingtalkPlugin,
    config,
    employeeId,
    connectionId,
  })
}
