/**
 * Daily cleanup of stale SOP workspaces in MinIO.
 *
 * Scans the `sop/` prefix and deletes every execution subdirectory whose
 * newest object is older than `SOP_WORKSPACE_RETENTION_DAYS` (default 30).
 *
 * Wired up from `instrumentation.ts`, so it runs once per server boot and
 * then once every `SOP_WORKSPACE_CLEANUP_INTERVAL_MS` (default 24h) for as
 * long as the process lives. Multi-replica deployments will see harmless
 * overlap — DeleteObject is idempotent.
 */

import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import { getMinioClient, MINIO_BUCKET } from '@/lib/storage/minio-client'

const logger = createLogger('SopWorkspaceCleanup')

const ROOT_PREFIX = 'sop/'
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function getRetentionMs(): number {
  const days = Number(process.env.SOP_WORKSPACE_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
  const safe = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
  return safe * 24 * 60 * 60 * 1000
}

function getIntervalMs(): number {
  const ms = Number(process.env.SOP_WORKSPACE_CLEANUP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_INTERVAL_MS
}

interface SopFolder {
  /** sop/{execId}/ */
  prefix: string
  /** Most recent LastModified across objects under this prefix. */
  newest: Date
}

/**
 * Walk every object under sop/ and bucket by execId. Returns one entry per
 * execId with the newest LastModified seen — the cleanup decision is made
 * per folder, not per object, so a long-running SOP that keeps writing
 * doesn't get half-deleted.
 */
async function listSopFolders(): Promise<SopFolder[]> {
  const client = getMinioClient()
  const byPrefix = new Map<string, Date>()
  let continuationToken: string | undefined

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: ROOT_PREFIX,
        ContinuationToken: continuationToken,
      })
    )

    for (const o of list.Contents ?? []) {
      if (!o.Key || !o.LastModified) continue
      // Match sop/{execId}/...; ignore objects directly under sop/.
      const rest = o.Key.slice(ROOT_PREFIX.length)
      const slash = rest.indexOf('/')
      if (slash <= 0) continue
      const prefix = `${ROOT_PREFIX}${rest.slice(0, slash + 1)}`
      const prev = byPrefix.get(prefix)
      if (!prev || o.LastModified > prev) byPrefix.set(prefix, o.LastModified)
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)

  return Array.from(byPrefix.entries()).map(([prefix, newest]) => ({ prefix, newest }))
}

async function deleteByPrefix(prefix: string): Promise<number> {
  const client = getMinioClient()
  let deleted = 0
  let continuationToken: string | undefined

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )
    const objects = list.Contents ?? []
    if (objects.length === 0) break

    await Promise.all(
      objects.map((o) =>
        client.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: o.Key! }))
      )
    )
    deleted += objects.length

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)

  return deleted
}

export interface CleanupResult {
  scanned: number
  deletedFolders: number
  deletedObjects: number
}

/** Run one cleanup pass. Safe to call manually for ops/testing. */
export async function runSopWorkspaceCleanup(): Promise<CleanupResult> {
  const cutoff = Date.now() - getRetentionMs()
  const folders = await listSopFolders()

  let deletedFolders = 0
  let deletedObjects = 0

  for (const folder of folders) {
    if (folder.newest.getTime() >= cutoff) continue
    try {
      const n = await deleteByPrefix(folder.prefix)
      deletedFolders++
      deletedObjects += n
    } catch (err) {
      logger.warn('Failed to delete stale SOP workspace folder', {
        prefix: folder.prefix,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (deletedFolders > 0) {
    logger.info('SOP workspace cleanup complete', {
      scanned: folders.length,
      deletedFolders,
      deletedObjects,
      retentionDays: getRetentionMs() / (24 * 60 * 60 * 1000),
    })
  }
  return { scanned: folders.length, deletedFolders, deletedObjects }
}

let timer: NodeJS.Timeout | null = null

/**
 * Schedule recurring cleanup. Idempotent — calling twice keeps a single
 * timer. Disabled when SOP_WORKSPACE_CLEANUP_DISABLED is truthy so ops
 * can opt out without code changes.
 */
export function startSopWorkspaceCleanupCron(): void {
  if (timer) return
  if (process.env.SOP_WORKSPACE_CLEANUP_DISABLED === '1') {
    logger.info('SOP workspace cleanup cron disabled via env')
    return
  }

  const interval = getIntervalMs()

  const tick = async () => {
    try {
      await runSopWorkspaceCleanup()
    } catch (err) {
      logger.error('SOP workspace cleanup tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Fire-and-forget initial run so a freshly-booted server immediately
  // reclaims any backlog, then settle into the recurring interval.
  void tick()
  timer = setInterval(tick, interval)
  // Don't keep the event loop alive solely for cleanup ticks.
  timer.unref?.()
  logger.info('SOP workspace cleanup cron started', { intervalMs: interval })
}
