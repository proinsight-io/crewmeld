import { createHash } from 'node:crypto'
import { createLogger } from '@crewmeld/logger'
import { type ConnectionOptions, Queue, Worker } from 'bullmq'
import { loadRagflowConfig, type RagflowConfig } from '@/lib/ragflow'
import { runDocumentImageBinding, type BindingRunResult } from './binding-service'
import { listPendingImageBindingDocuments } from './repository'

const logger = createLogger('DocumentImageBindingQueue')
const QUEUE_NAME = 'ragflow-document-image-binding'

export interface DocumentImageBindingPayload {
  datasetId: string
  documentId: string
  generation: number
  pollAttempt: number
}

interface QueueLike {
  add(
    name: string,
    data: DocumentImageBindingPayload,
    options: { jobId: string; delay: number }
  ): Promise<unknown>
}

interface BindingJobDependencies {
  run(payload: DocumentImageBindingPayload, config: RagflowConfig): Promise<BindingRunResult>
  enqueue(payload: DocumentImageBindingPayload, delay?: number): Promise<boolean>
  loadConfig(): Promise<RagflowConfig>
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

function getBindingQueue(): QueueLike | null {
  if (queue) return queue
  const redis = connection()
  if (!redis) return null
  queue = new Queue(QUEUE_NAME, {
    connection: redis,
    prefix: queuePrefix(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  })
  return queue
}

export function bindingQueueJobId(payload: DocumentImageBindingPayload): string {
  const digest = createHash('sha256')
    .update(`${payload.datasetId}\0${payload.documentId}\0${payload.generation}`)
    .digest('hex')
    .slice(0, 32)
  return `image-binding-${digest}-${payload.pollAttempt}`
}

export async function dispatchDocumentImageBinding(
  payload: DocumentImageBindingPayload,
  queueFactory: () => QueueLike | null = getBindingQueue,
  delay = 0
): Promise<boolean> {
  const target = queueFactory()
  if (!target) return false
  await target.add('bind', payload, { jobId: bindingQueueJobId(payload), delay })
  return true
}

export async function enqueueDocumentImageBinding(
  datasetId: string,
  documentId: string,
  generation: number
): Promise<boolean> {
  return await dispatchDocumentImageBinding({ datasetId, documentId, generation, pollAttempt: 0 })
}

const productionJobDependencies: BindingJobDependencies = {
  async run(payload, config) {
    return await runDocumentImageBinding({
      config,
      datasetId: payload.datasetId,
      documentId: payload.documentId,
      generation: payload.generation,
    })
  },
  enqueue: async (payload, delay) =>
    await dispatchDocumentImageBinding(payload, getBindingQueue, delay),
  loadConfig: loadRagflowConfig,
}

export async function handleDocumentImageBindingJob(
  payload: DocumentImageBindingPayload,
  dependencies: BindingJobDependencies = productionJobDependencies
): Promise<BindingRunResult> {
  const config = await dependencies.loadConfig()
  const result = await dependencies.run(payload, config)
  if (result.status === 'waiting') {
    const nextPayload = { ...payload, pollAttempt: payload.pollAttempt + 1 }
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(payload.pollAttempt, 4))
    await dependencies.enqueue(nextPayload, delay)
  }
  return result
}

export async function recoverDocumentImageBindingJobs(
  dependencies: {
    list(): ReturnType<typeof listPendingImageBindingDocuments>
    enqueue(payload: DocumentImageBindingPayload): Promise<boolean>
  } = {
    list: listPendingImageBindingDocuments,
    enqueue: async (payload) => await dispatchDocumentImageBinding(payload),
  }
): Promise<void> {
  const pending = await dependencies.list()
  for (const item of pending) {
    await dependencies.enqueue({ ...item, pollAttempt: 0 })
  }
}

export function initDocumentImageBindingWorker(): Worker | null {
  const redis = connection()
  if (!redis) {
    logger.warn('Skipping document image binding worker initialization because Redis is unavailable')
    return null
  }
  return new Worker(
    QUEUE_NAME,
    async (job) => {
      await handleDocumentImageBindingJob(job.data as DocumentImageBindingPayload)
    },
    { connection: redis, prefix: queuePrefix(), concurrency: 2 }
  )
}
