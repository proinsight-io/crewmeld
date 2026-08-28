import { createLogger } from '@crewmeld/logger'

const logger = createLogger('QaSyncService')

export type QaSyncReason = 'create' | 'import' | 'edit' | 'delete' | 'enable' | 'retry' | 'manual'

export async function mutateThenEnqueue<T>(
  mutate: () => Promise<{ value: T; batchId: string }>,
  enqueue: (batchId: string, reason: QaSyncReason) => Promise<unknown>,
  reason: QaSyncReason
): Promise<{ value: T; syncPending: boolean }> {
  const committed = await mutate()
  try {
    await enqueue(committed.batchId, reason)
    return { value: committed.value, syncPending: false }
  } catch (error) {
    logger.warn('QA batch sync enqueue failed after mutation commit', {
      batchId: committed.batchId,
      reason,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return { value: committed.value, syncPending: true }
  }
}

export async function enqueueQaBatchSync(
  batchId: string,
  reason: QaSyncReason,
  dependencies?: {
    persist(batchId: string, reason: QaSyncReason): Promise<string>
    dispatch(jobId: string): Promise<void>
  }
): Promise<string> {
  const persist = dependencies?.persist ?? (async (id: string, syncReason: QaSyncReason) => {
    const { qaSyncRepository } = await import('./sync-repository')
    return qaSyncRepository.enqueue(id, syncReason)
  })
  const dispatch = dependencies?.dispatch ?? (async (jobId: string) => {
    const { dispatchQaSyncJob } = await import('./sync-queue')
    await dispatchQaSyncJob(jobId)
  })
  const jobId = await persist(batchId, reason)
  await dispatch(jobId)
  return jobId
}
