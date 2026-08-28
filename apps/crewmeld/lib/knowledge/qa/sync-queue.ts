import { createLogger } from '@crewmeld/logger'
import { type ConnectionOptions, Queue, Worker } from 'bullmq'

const logger = createLogger('QaSyncQueue')
const QUEUE_NAME = 'qa-batch-sync'

interface QaQueueLike {
  add(name: string, data: { jobId: string }, options: { jobId: string }): Promise<unknown>
}

interface RecoveryRepository {
  listDispatchableJobs(): Promise<Array<{ id: string }>>
}

let queue: Queue | null = null

function connection(): ConnectionOptions | null {
  const value = process.env.REDIS_URL
  if (!value) return null
  const url = new URL(value)
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
  }
}

function queuePrefix(): string {
  return process.env.MQ_QUEUE_PREFIX || 'bull'
}

export function getQaSyncQueue(): QaQueueLike | null {
  if (queue) return queue
  const redis = connection()
  if (!redis) return null
  queue = new Queue(QUEUE_NAME, {
    connection: redis,
    prefix: queuePrefix(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  })
  return queue
}

export async function dispatchQaSyncJob(
  jobId: string,
  queueFactory: () => QaQueueLike | null = getQaSyncQueue,
  queueJobId = jobId
): Promise<void> {
  const target = queueFactory()
  if (!target) throw new Error('QA sync queue unavailable')
  await target.add('sync', { jobId }, { jobId: queueJobId })
}

export async function recoverQaSyncJobs(
  repository: RecoveryRepository,
  dispatch: (jobId: string, queueJobId: string) => Promise<void> = (jobId, queueJobId) =>
    dispatchQaSyncJob(jobId, getQaSyncQueue, queueJobId)
): Promise<void> {
  const jobs = await repository.listDispatchableJobs()
  for (const job of jobs) await dispatch(job.id, `${job.id}-recovery-${crypto.randomUUID()}`)
}

export function initQaSyncWorker(): Worker | null {
  const redis = connection()
  if (!redis) {
    logger.warn('Skipping QA sync worker initialization because Redis is unavailable')
    return null
  }
  return new Worker(
    QUEUE_NAME,
    async (bullJob) => {
      const { qaSyncRepository } = await import('./sync-repository')
      const persisted = await qaSyncRepository.getJob((bullJob.data as { jobId: string }).jobId)
      if (!persisted) throw new Error('Persisted QA sync job not found')
      const { createProductionQaSyncWorker } = await import('./sync-worker')
      const result = await (await createProductionQaSyncWorker()).run(persisted)
      if (result.status === 'failed' || result.status === 'cancelled')
        throw new Error(`QA synchronization ${result.status}`)
    },
    { connection: redis, prefix: queuePrefix(), concurrency: 4 }
  )
}
