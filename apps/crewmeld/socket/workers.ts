import { createLogger } from '@crewmeld/logger'
import type { ConnectionOptions, Worker } from 'bullmq'
import { initQaSyncWorker, recoverQaSyncJobs } from '@/lib/knowledge/qa/sync-queue'
import { initSopWorkers } from '@/lib/sop/queue'
import { initSchedulerWorker, syncScheduledTasks } from '@/lib/sop/scheduler'

const logger = createLogger('BackgroundWorkers')

let registered = false
const workers: Worker[] = []

/**
 * Parse REDIS_URL into BullMQ connection options. Returns null when no
 * REDIS_URL is configured — caller is expected to skip registration in
 * that case rather than crashing.
 */
function parseRedisConnection(): ConnectionOptions | null {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null

  try {
    const url = new URL(redisUrl)
    return {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
    }
  } catch (error) {
    logger.error('Invalid REDIS_URL — background workers disabled', { error })
    return null
  }
}

/**
 * Register all BullMQ workers that consume the Trigger.dev replacement
 * queues. Idempotent: subsequent calls are no-ops.
 */
export function registerBackgroundWorkers(): void {
  if (registered) return

  const connection = parseRedisConnection()
  if (!connection) {
    logger.warn('REDIS_URL not configured, background workers will not start')
    registered = true
    return
  }

  // Initialize SOP timeout and notification workers (sop-timeout, sop-notification queues)
  initSopWorkers()

  // Initialize scheduled task worker and sync active tasks from DB
  initSchedulerWorker()
  void syncScheduledTasks()

  const qaSyncWorker = initQaSyncWorker()
  if (qaSyncWorker) workers.push(qaSyncWorker)
  void (async () => {
    try {
      const { qaSyncRepository } = await import('@/lib/knowledge/qa/sync-repository')
      await recoverQaSyncJobs(qaSyncRepository)
    } catch (error) {
      logger.error('QA sync cold recovery failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })()

  registered = true
  logger.info('Registered SOP, scheduler, and QA sync workers')
}

/**
 * Stop all workers and drop their Redis connections. Safe to call when
 * registerBackgroundWorkers() never succeeded.
 */
export async function shutdownBackgroundWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()))
  workers.length = 0
  registered = false
}
