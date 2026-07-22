/**
 * Daily cleanup of stale SOP file workspaces on NFS.
 *
 * The workspace lives at `<bff-root>/sop-files/<Y>/<M>/<D>/<execId>/`. The
 * Y/M/D layer is the SOP's start date, so age is read straight from the path
 * — no per-file stat. Every execId dir under a day older than
 * `SOP_WORKSPACE_RETENTION_DAYS` (default 30) is removed, and emptied
 * day/month/year dirs are pruned.
 *
 * Wired up from `instrumentation.ts`, so it runs once per server boot and
 * then once every `SOP_WORKSPACE_CLEANUP_INTERVAL_MS` (default 24h) for as
 * long as the process lives. Multi-replica deployments will see harmless
 * overlap — rm is idempotent.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { paths } from '@/lib/dev-studio/paths'

const logger = createLogger('SopWorkspaceCleanup')

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

export interface CleanupResult {
  scannedDays: number
  deletedExecs: number
}

/** List numeric-named subdirs of `dir` (missing dir → []). */
async function numericDirs(dir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true })
    return ents.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** Remove `dir` if it is now empty. Silent on non-empty / already-gone. */
async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir)
  } catch {
    /* not empty or already gone — fine */
  }
}

/** Run one cleanup pass. Safe to call manually for ops/testing. */
export async function runSopWorkspaceCleanup(): Promise<CleanupResult> {
  const cutoff = Date.now() - getRetentionMs()
  const root = paths.sopFiles.rootForBff()

  let scannedDays = 0
  let deletedExecs = 0

  for (const y of await numericDirs(root)) {
    const yDir = path.join(root, y)
    for (const m of await numericDirs(yDir)) {
      const mDir = path.join(yDir, m)
      for (const d of await numericDirs(mDir)) {
        scannedDays++
        const dDir = path.join(mDir, d)
        // Keep the whole day until UTC midnight of Y/M/D ages past the cutoff.
        const dayMs = Date.UTC(Number(y), Number(m) - 1, Number(d))
        if (dayMs >= cutoff) continue
        try {
          for (const exec of await fs.readdir(dDir)) {
            await fs.rm(path.join(dDir, exec), { recursive: true, force: true })
            deletedExecs++
          }
          await rmdirIfEmpty(dDir)
        } catch (err) {
          logger.warn('Failed to clean stale sop-files day', {
            day: `${y}/${m}/${d}`,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      await rmdirIfEmpty(mDir)
    }
    await rmdirIfEmpty(yDir)
  }

  if (deletedExecs > 0) {
    logger.info('SOP workspace cleanup complete', {
      scannedDays,
      deletedExecs,
      retentionDays: getRetentionMs() / (24 * 60 * 60 * 1000),
    })
  }
  return { scannedDays, deletedExecs }
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
