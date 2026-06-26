import { createLogger } from '@crewmeld/logger'
import { type ConnectionOptions, Queue, Worker } from 'bullmq'
import type {
  AsyncToolWatchdogPayload,
  NotificationJobPayload,
  TimeoutJobPayload,
} from '@/types/sop'

const logger = createLogger('SopQueue')

let cachedConnection: ConnectionOptions | null = null

/**
 * Parse REDIS_URL env var into BullMQ ConnectionOptions
 *
 * Unlike `getRedisClient()` (returns null when Redis unavailable),
 * BullMQ requires Redis. Returns null when no REDIS_URL,
 * queue factory returning null means SOP features unavailable.
 */
/**
 * BullMQ key namespace prefix.
 *
 * Reads `MQ_QUEUE_PREFIX`; falls back to BullMQ's own default (`bull`) when
 * unset or empty, so deployments that don't set it keep their existing keys.
 * Must be applied consistently to every Queue (producer) and Worker (consumer)
 * — a mismatch leaves jobs enqueued under one namespace and consumed from none.
 */
export function getQueuePrefix(): string {
  return process.env.MQ_QUEUE_PREFIX || 'bull'
}

function getConnection(): ConnectionOptions | null {
  if (typeof window !== 'undefined') return null
  if (cachedConnection) return cachedConnection

  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    logger.warn('REDIS_URL not configured, SOP queues unavailable')
    return null
  }

  try {
    const url = new URL(redisUrl)
    cachedConnection = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      db: Number(url.pathname.slice(1)) || 0,
    }
    return cachedConnection
  } catch (error) {
    logger.error('Failed to parse REDIS_URL', { error: (error as Error).message })
    return null
  }
}

let sopTimeoutQueue: Queue | null = null
let sopNotificationQueue: Queue | null = null
let asyncToolWatchdogQueue: Queue | null = null

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
}

/**
 * Get SOP timeout queue (lazy initialization)
 *
 * @returns Queue instance, null when Redis unavailable
 */
export function getSopTimeoutQueue(): Queue | null {
  if (sopTimeoutQueue) return sopTimeoutQueue
  const conn = getConnection()
  if (!conn) return null

  sopTimeoutQueue = new Queue('sop-timeout', {
    connection: conn,
    prefix: getQueuePrefix(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  return sopTimeoutQueue
}

/**
 * Get SOP notification queue (lazy initialization)
 *
 * @returns Queue instance, null when Redis unavailable
 */
export function getSopNotificationQueue(): Queue | null {
  if (sopNotificationQueue) return sopNotificationQueue
  const conn = getConnection()
  if (!conn) return null

  sopNotificationQueue = new Queue('sop-notification', {
    connection: conn,
    prefix: getQueuePrefix(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  return sopNotificationQueue
}

/**
 * Get the async-tool watchdog queue (lazy initialization).
 *
 * Holds a delayed job per dispatched async tool call; if the call never calls
 * back, the job fires and fails it so the SOP does not hang forever.
 *
 * @returns Queue instance, null when Redis unavailable
 */
export function getAsyncToolWatchdogQueue(): Queue | null {
  if (asyncToolWatchdogQueue) return asyncToolWatchdogQueue
  const conn = getConnection()
  if (!conn) return null

  asyncToolWatchdogQueue = new Queue('sop-async-tool-watchdog', {
    connection: conn,
    prefix: getQueuePrefix(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  return asyncToolWatchdogQueue
}

/** Cancel a watchdog job once its tool call has called back (best-effort). */
export async function cancelAsyncToolWatchdog(jobId: string): Promise<void> {
  const queue = getAsyncToolWatchdogQueue()
  if (!queue) return
  try {
    await queue.remove(jobId)
  } catch {
    // Already removed or currently firing — nothing to do.
  }
}

/**
 * Initialize SOP Workers — called on process startup
 *
 * SSR guard: do not initialize in browser environment.
 * Skip when no Redis (SOP features degraded).
 */
export function initSopWorkers(): void {
  if (typeof window !== 'undefined') return

  const conn = getConnection()
  if (!conn) {
    logger.warn('Skipping SOP workers initialization (no Redis)')
    return
  }

  new Worker(
    'sop-timeout',
    async (job) => {
      const mod = await import('@/lib/sop/workers/timeout-worker')
      await mod.processTimeout(job.data as TimeoutJobPayload)
    },
    {
      connection: conn,
      prefix: getQueuePrefix(),
      concurrency: 5,
    }
  )

  new Worker(
    'sop-notification',
    async (job) => {
      const mod = await import('@/lib/sop/workers/notification-worker')
      await mod.processNotification(job.data as NotificationJobPayload)
    },
    {
      connection: conn,
      prefix: getQueuePrefix(),
      concurrency: 5,
    }
  )

  new Worker(
    'sop-async-tool-watchdog',
    async (job) => {
      const mod = await import('@/lib/sop/workers/async-tool-watchdog-worker')
      await mod.processAsyncToolWatchdog(job.data as AsyncToolWatchdogPayload)
    },
    {
      connection: conn,
      prefix: getQueuePrefix(),
      concurrency: 5,
    }
  )

  logger.info('SOP workers initialized')
}
