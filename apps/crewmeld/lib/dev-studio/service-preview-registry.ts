import { randomBytes } from 'node:crypto'
import { createLogger } from '@crewmeld/logger'
import { getRedisClient } from '@/lib/core/config/redis'

const logger = createLogger('ServicePreviewRegistry')
const PREVIEW_KEY_PREFIX = 'dev-studio:preview:'
const SESSION_KEY_PREFIX = 'dev-studio:preview-session:'

export const SERVICE_PREVIEW_TTL_SECONDS = 300

export interface ServicePreviewRecord {
  previewId: string
  userId: string
  sessionId: string
  executionId: string
  sandboxId: string
  port: number
  servicePath: string
  expiresAt: string
}

type ServicePreviewInput = Omit<ServicePreviewRecord, 'previewId' | 'expiresAt'>

function previewKey(previewId: string): string {
  return `${PREVIEW_KEY_PREFIX}${previewId}`
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`
}

function parseRecord(value: string | null): ServicePreviewRecord | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.previewId !== 'string' ||
      typeof record.userId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.executionId !== 'string' ||
      typeof record.sandboxId !== 'string' ||
      typeof record.port !== 'number' ||
      !Number.isInteger(record.port) ||
      typeof record.servicePath !== 'string' ||
      typeof record.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(record.expiresAt))
    ) {
      return null
    }
    return record as unknown as ServicePreviewRecord
  } catch {
    return null
  }
}

/** Register a short-lived, session-bound capability for an HTML preview. */
export async function registerServicePreview(
  input: ServicePreviewInput
): Promise<ServicePreviewRecord | null> {
  const redis = getRedisClient()
  if (!redis) return null

  const record: ServicePreviewRecord = {
    ...input,
    previewId: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + SERVICE_PREVIEW_TTL_SECONDS * 1000).toISOString(),
  }
  try {
    const result = await redis
      .multi()
      .set(previewKey(record.previewId), JSON.stringify(record), 'EX', SERVICE_PREVIEW_TTL_SECONDS)
      .set(sessionKey(record.sessionId), record.previewId, 'EX', SERVICE_PREVIEW_TTL_SECONDS)
      .exec()
    if (!result || result.some(([error]) => error !== null)) return null
    return record
  } catch (error) {
    logger.warn('Failed to register service preview', {
      sessionId: input.sessionId,
      executionId: input.executionId,
      sandboxId: input.sandboxId,
      error,
    })
    return null
  }
}

/** Resolve a capability only while its session index and explicit expiry agree. */
export async function getServicePreview(previewId: string): Promise<ServicePreviewRecord | null> {
  const redis = getRedisClient()
  if (!redis || !previewId) return null
  try {
    const record = parseRecord(await redis.get(previewKey(previewId)))
    if (!record || record.previewId !== previewId || Date.parse(record.expiresAt) <= Date.now()) {
      return null
    }
    const indexedPreviewId = await redis.get(sessionKey(record.sessionId))
    return indexedPreviewId === previewId ? record : null
  } catch (error) {
    logger.warn('Failed to resolve service preview', { error })
    return null
  }
}

/** Revoke the current preview owned by a Dev Studio session. */
export async function revokeSessionPreview(
  sessionId: string
): Promise<ServicePreviewRecord | null> {
  const redis = getRedisClient()
  if (!redis) return null
  try {
    const previewId = await redis.get(sessionKey(sessionId))
    if (!previewId) return null
    const record = parseRecord(await redis.get(previewKey(previewId)))
    await redis.multi().del(sessionKey(sessionId), previewKey(previewId)).exec()
    return record && record.sessionId === sessionId ? record : null
  } catch (error) {
    logger.warn('Failed to revoke session service preview', { sessionId, error })
    return null
  }
}

/** Revoke one known capability and its matching session index. */
export async function revokeServicePreview(
  previewId: string
): Promise<ServicePreviewRecord | null> {
  const redis = getRedisClient()
  if (!redis) return null
  try {
    const record = parseRecord(await redis.get(previewKey(previewId)))
    if (!record) {
      await redis.multi().del(previewKey(previewId)).exec()
      return null
    }
    await redis.multi().del(previewKey(previewId), sessionKey(record.sessionId)).exec()
    return record
  } catch (error) {
    logger.warn('Failed to revoke service preview', { error })
    return null
  }
}
