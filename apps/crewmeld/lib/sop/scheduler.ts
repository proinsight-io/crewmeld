/**
 * Scheduled Task Scheduler — based on BullMQ Repeatable Jobs
 *
 * Each scheduled task maps to a BullMQ repeatable job.
 * When the time comes, the Worker reads task config from DB and triggers SOP execution.
 */

import { db } from '@crewmeld/db'
import { scheduledTasks, sopDefinitions, sopExecutions } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { type ConnectionOptions, Queue, Worker } from 'bullmq'
import { CronExpressionParser } from 'cron-parser'
import { and, eq } from 'drizzle-orm'
import { generateExecutionId } from '@/lib/core/execution-id'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { executeSop, transitionStatus } from './engine'
import { getQueuePrefix, getSopTimeoutQueue } from './queue'

const logger = createLogger('SopScheduler')

let schedulerQueue: Queue | null = null

function getConnection(): ConnectionOptions | null {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  try {
    const url = new URL(redisUrl)
    return {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      db: Number(url.pathname.slice(1)) || 0,
    }
  } catch {
    return null
  }
}

function getSchedulerQueue(): Queue | null {
  if (schedulerQueue) return schedulerQueue
  const conn = getConnection()
  if (!conn) return null
  schedulerQueue = new Queue('sop-scheduler', {
    connection: conn,
    prefix: getQueuePrefix(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  })
  return schedulerQueue
}

/**
 * Compute next run time (precise parsing via cron-parser)
 */
export function computeNextRunAt(cron: string, timezone: string): Date | null {
  try {
    const interval = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: new Date(),
    })
    return interval.next().toDate()
  } catch (err) {
    logger.warn('Cron expression parse failed', { cron, timezone, error: (err as Error).message })
    return null
  }
}

/**
 * Register a scheduled task in BullMQ
 */
export async function registerScheduledTask(
  taskId: string,
  cron: string,
  timezone: string
): Promise<void> {
  const queue = getSchedulerQueue()
  if (!queue) {
    logger.warn('BullMQ unavailable, scheduled task not registered', { taskId })
    return
  }

  try {
    await queue.add(
      'scheduled-task',
      { scheduledTaskId: taskId },
      {
        repeat: {
          pattern: cron,
          tz: timezone,
        },
        jobId: `schtask-${taskId}`,
      }
    )
    logger.info('Scheduled task registered', { taskId, cron, timezone })
  } catch (err) {
    logger.error('Scheduled task registration failed', { taskId, error: (err as Error).message })
  }
}

/**
 * Remove BullMQ scheduling for a scheduled task
 */
export async function removeScheduledTask(taskId: string): Promise<void> {
  const queue = getSchedulerQueue()
  if (!queue) return

  try {
    const repeatableJobs = await queue.getRepeatableJobs()
    for (const job of repeatableJobs) {
      if (job.id === `schtask-${taskId}`) {
        await queue.removeRepeatableByKey(job.key)
        logger.info('Scheduled task removed', { taskId })
        return
      }
    }
  } catch (err) {
    logger.error('Scheduled task removal failed', { taskId, error: (err as Error).message })
  }
}

/**
 * Process scheduled task trigger — Worker callback
 */
async function processScheduledTask(data: { scheduledTaskId: string }): Promise<void> {
  const { scheduledTaskId } = data

  // Read task config
  const [task] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, scheduledTaskId), eq(scheduledTasks.isActive, true)))
    .limit(1)

  if (!task) {
    logger.warn('Scheduled task not found or disabled', { scheduledTaskId })
    return
  }

  // Read SOP definition
  const [definition] = await db
    .select()
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, task.sopDefinitionId))
    .limit(1)

  if (!definition) {
    logger.warn('Associated SOP not found', { scheduledTaskId, sopId: task.sopDefinitionId })
    return
  }

  // Create execution record
  const executionId = generateExecutionId('sop')
  const triggerData = (task.triggerData as Record<string, unknown>) ?? {}

  // Scheduled tasks have no HTTP request context; inject baseUrl from env vars for approval notifications
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    triggerData._meta = { ...((triggerData._meta as Record<string, unknown>) ?? {}), baseUrl }
  }

  await db.insert(sopExecutions).values({
    id: executionId,
    sopDefinitionId: task.sopDefinitionId,
    sopVersion: definition.version,
    triggeredBy: task.createdBy,
    scheduledTaskId,
    status: 'pending',
    stateSnapshot: {},
    triggerData,
  })

  // Update task's lastRunAt and nextRunAt
  const nextRun = computeNextRunAt(task.cron, task.timezone)
  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextRun,
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, scheduledTaskId))

  // Register SOP-level timeout
  const timeoutQueue = getSopTimeoutQueue()
  if (timeoutQueue && definition.sopTimeoutMinutes > 0) {
    await timeoutQueue.add(
      'sop-timeout',
      {
        executionId,
        type: 'sop',
      },
      { delay: definition.sopTimeoutMinutes * 60 * 1000 }
    )
  }

  // Start execution
  const ok = await transitionStatus(executionId, 'pending', 'running', {
    startedAt: new Date(),
  })

  if (ok) {
    void executeSop(executionId)
    logger.info('Scheduled task triggered SOP execution', {
      scheduledTaskId,
      executionId,
      sopId: task.sopDefinitionId,
    })
  } else {
    logger.error('Scheduled task failed to start SOP', { scheduledTaskId, executionId })
  }
}

/**
 * Initialize the scheduled task Worker — called at process startup
 */
export function initSchedulerWorker(): void {
  if (typeof window !== 'undefined') return
  const conn = getConnection()
  if (!conn) {
    logger.warn('Skipping scheduled task worker init (no Redis)')
    return
  }

  new Worker(
    'sop-scheduler',
    async (job) => {
      await processScheduledTask(job.data as { scheduledTaskId: string })
    },
    {
      connection: conn,
      prefix: getQueuePrefix(),
      concurrency: 3,
    }
  )

  logger.info('Scheduled task worker initialized')
}

/**
 * Cold recovery: sync all active scheduled tasks to BullMQ at application startup
 */
export async function syncScheduledTasks(): Promise<void> {
  const queue = getSchedulerQueue()
  if (!queue) return

  try {
    const activeTasks = await db
      .select({
        id: scheduledTasks.id,
        cron: scheduledTasks.cron,
        timezone: scheduledTasks.timezone,
      })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.isActive, true))

    if (activeTasks.length === 0) {
      logger.info('No active scheduled tasks to sync')
      return
    }

    // Get existing registered repeatable jobs
    const existingJobs = await queue.getRepeatableJobs()
    const existingIds = new Set(existingJobs.map((j) => j.id))

    let registered = 0
    for (const task of activeTasks) {
      if (!existingIds.has(`schtask-${task.id}`)) {
        await registerScheduledTask(task.id, task.cron, task.timezone)
        registered++
      }
    }

    logger.info('Scheduled task sync completed', {
      total: activeTasks.length,
      newlyRegistered: registered,
    })
  } catch (err) {
    logger.error('Scheduled task sync failed', { error: (err as Error).message })
  }
}
