import { createLogger } from '@crewmeld/logger'
import { getOpenSandboxClient, type OpenSandboxClient } from './opensandbox-client'
import {
  registerServicePreview,
  revokeSessionPreview,
  SERVICE_PREVIEW_TTL_SECONDS,
} from './service-preview-registry'
import type { ServiceTestMetadata } from './service-test-result'

const logger = createLogger('ServicePreviewLifecycle')

export interface CreateHtmlServicePreviewInput {
  userId: string
  sessionId: string
  executionId: string
  sandboxId: string
  port: number
  servicePath: string
  service: ServiceTestMetadata
}

export interface CreateHtmlServicePreviewResult {
  kept: boolean
  service: ServiceTestMetadata
}

async function destroyBestEffort(
  client: OpenSandboxClient,
  sandboxId: string,
  sessionId: string
): Promise<void> {
  try {
    await client.destroy(sandboxId)
  } catch (error) {
    logger.warn('Failed to destroy service preview sandbox', { sandboxId, sessionId, error })
  }
}

/** Revoke access first, then best-effort destroy the session's preview sandbox. */
export async function destroySessionServicePreview(
  sessionId: string,
  client: OpenSandboxClient = getOpenSandboxClient()
): Promise<void> {
  const record = await revokeSessionPreview(sessionId)
  if (!record) return
  await destroyBestEffort(client, record.sandboxId, sessionId)
}

/** Renew an HTML sandbox and expose it through a short-lived internal proxy URL. */
export async function createHtmlServicePreview(
  client: OpenSandboxClient,
  input: CreateHtmlServicePreviewInput
): Promise<CreateHtmlServicePreviewResult> {
  try {
    await client.renew(input.sandboxId, SERVICE_PREVIEW_TTL_SECONDS)
  } catch (error) {
    logger.warn('Failed to renew HTML preview sandbox', {
      sessionId: input.sessionId,
      executionId: input.executionId,
      sandboxId: input.sandboxId,
      error,
    })
    await destroyBestEffort(client, input.sandboxId, input.sessionId)
    return { kept: false, service: input.service }
  }

  const record = await registerServicePreview({
    userId: input.userId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    sandboxId: input.sandboxId,
    port: input.port,
    servicePath: input.servicePath,
  })
  if (!record) {
    await destroyBestEffort(client, input.sandboxId, input.sessionId)
    return { kept: false, service: input.service }
  }

  return {
    kept: true,
    service: {
      ...input.service,
      previewUrl: `/api/employee/dev-studio/sessions/${encodeURIComponent(input.sessionId)}/preview/${encodeURIComponent(record.previewId)}/`,
      previewExpiresAt: record.expiresAt,
    },
  }
}
