import type { QaCsvRenderRow } from './csv-renderer'
import { renderQaBatchCsv } from './csv-renderer'

export interface QaActiveVersion {
  id: string
  checksum: string
  remoteDocumentId: string
}
export interface QaSyncSnapshot {
  batchId: string
  datasetId: string
  rows: QaCsvRenderRow[]
  activeVersion: QaActiveVersion | null
}
export interface QaSyncRepository {
  readSnapshot(batchId: string): Promise<QaSyncSnapshot>
  createPending(
    batchId: string,
    checksum: string,
    filename: string,
    jobId: string
  ): Promise<{ versionId: string; jobId: string; filename: string; remoteDocumentId: string | null }>
  markRemoteDocument(versionId: string, remoteDocumentId: string): Promise<void>
  clearRemoteDocument(versionId: string): Promise<void>
  markFailed(versionId: string, jobId: string, error: string): Promise<void>
  activate(input: {
    batchId: string
    versionId: string
    jobId: string
    checksum: string
    remoteDocumentId: string
    oldVersionId: string | null
    at: Date
  }): Promise<void>
  recordCleanupFailure(versionId: string, error: string): Promise<void>
  markCleanupComplete(versionId: string): Promise<void>
  markNoop(jobId: string): Promise<void>
  markCancelled(versionId: string, jobId: string, cleanupError: string | null): Promise<void>
}
export interface QaSyncRagflow {
  upload(datasetId: string, bytes: Uint8Array, filename: string): Promise<string>
  parse(datasetId: string, documentId: string): Promise<void>
  status(datasetId: string, documentId: string): Promise<'running' | 'done' | 'failed'>
  disable(datasetId: string, documentId: string): Promise<void>
  delete(datasetId: string, documentId: string): Promise<void>
  stop(datasetId: string, documentId: string): Promise<void>
}
export interface QaBatchLock {
  withBatchLock<T>(batchId: string, operation: () => Promise<T>): Promise<T>
}
export interface QaSyncJob {
  id: string
  batchId: string
  reason: string
}
export type QaSyncResult = {
  status: 'active' | 'noop' | 'failed' | 'cancelled'
  versionId?: string
}
interface WorkerDependencies {
  repository: QaSyncRepository
  ragflow: QaSyncRagflow
  lock: QaBatchLock
  now: () => Date
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs: number
  pollTimeoutMs: number
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown synchronization error'
}

export class QaSyncWorker {
  constructor(private readonly dependencies: WorkerDependencies) {}
  async run(job: QaSyncJob, signal?: AbortSignal): Promise<QaSyncResult> {
    return this.dependencies.lock.withBatchLock(job.batchId, () => this.runLocked(job, signal))
  }
  private async runLocked(job: QaSyncJob, signal?: AbortSignal): Promise<QaSyncResult> {
    if (signal?.aborted) return { status: 'cancelled' }
    const snapshot = await this.dependencies.repository.readSnapshot(job.batchId)
    const rendered = renderQaBatchCsv(snapshot.rows)
    if (snapshot.activeVersion?.checksum === rendered.checksum) {
      await this.dependencies.repository.markNoop(job.id)
      return { status: 'noop', versionId: snapshot.activeVersion.id }
    }
    const filename = `qa-${job.batchId}-${rendered.checksum.slice(0, 12)}.csv`
    const pending = await this.dependencies.repository.createPending(
      job.batchId,
      rendered.checksum,
      filename,
      job.id
    )
    try {
      if (pending.remoteDocumentId) {
        try {
          await this.dependencies.ragflow.stop(snapshot.datasetId, pending.remoteDocumentId)
        } catch {}
        try {
          await this.dependencies.ragflow.disable(snapshot.datasetId, pending.remoteDocumentId)
        } catch {}
        await this.dependencies.ragflow.delete(snapshot.datasetId, pending.remoteDocumentId)
        await this.dependencies.repository.clearRemoteDocument(pending.versionId)
      }
      const documentId = await this.dependencies.ragflow.upload(
        snapshot.datasetId,
        rendered.bytes,
        filename
      )
      await this.dependencies.repository.markRemoteDocument(pending.versionId, documentId)
      await this.dependencies.ragflow.parse(snapshot.datasetId, documentId)
      const started = this.dependencies.now().getTime()
      while (true) {
        if (signal?.aborted)
          return this.cancel(snapshot.datasetId, documentId, pending.versionId, pending.jobId)
        const status = await this.dependencies.ragflow.status(snapshot.datasetId, documentId)
        if (status === 'done') break
        if (status === 'failed') throw new Error('RAGFlow parse failed')
        if (this.dependencies.now().getTime() - started >= this.dependencies.pollTimeoutMs)
          throw new Error('RAGFlow parse timed out')
        await this.dependencies.sleep(this.dependencies.pollIntervalMs, signal)
      }
      if (signal?.aborted)
        return this.cancel(snapshot.datasetId, documentId, pending.versionId, pending.jobId)
      await this.dependencies.repository.activate({
        batchId: job.batchId,
        versionId: pending.versionId,
        jobId: pending.jobId,
        checksum: rendered.checksum,
        remoteDocumentId: documentId,
        oldVersionId: snapshot.activeVersion?.id ?? null,
        at: this.dependencies.now(),
      })
      if (snapshot.activeVersion) {
        try {
          await this.dependencies.ragflow.disable(
            snapshot.datasetId,
            snapshot.activeVersion.remoteDocumentId
          )
          await this.dependencies.ragflow.delete(
            snapshot.datasetId,
            snapshot.activeVersion.remoteDocumentId
          )
          await this.dependencies.repository.markCleanupComplete(snapshot.activeVersion.id)
        } catch (error) {
          await this.dependencies.repository.recordCleanupFailure(
            snapshot.activeVersion.id,
            message(error)
          )
        }
      }
      return { status: 'active', versionId: pending.versionId }
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled', versionId: pending.versionId }
      await this.dependencies.repository.markFailed(
        pending.versionId,
        pending.jobId,
        message(error)
      )
      return { status: 'failed', versionId: pending.versionId }
    }
  }

  private async cancel(
    datasetId: string,
    documentId: string,
    versionId: string,
    jobId: string
  ): Promise<QaSyncResult> {
    const errors: string[] = []
    for (const operation of [
      () => this.dependencies.ragflow.stop(datasetId, documentId),
      () => this.dependencies.ragflow.disable(datasetId, documentId),
    ]) {
      try {
        await operation()
      } catch (error) {
        errors.push(message(error))
      }
    }
    try {
      await this.dependencies.ragflow.delete(datasetId, documentId)
      await this.dependencies.repository.clearRemoteDocument(versionId)
    } catch (error) {
      errors.push(message(error))
    }
    const cleanupError = errors.length ? errors.join('; ') : null
    await this.dependencies.repository.markCancelled(versionId, jobId, cleanupError)
    return { status: 'cancelled', versionId }
  }
}

export async function createProductionQaSyncWorker(): Promise<QaSyncWorker> {
  const ragflow = await import('@/lib/ragflow')
  const production = await import('./sync-repository')
  const client: QaSyncRagflow = {
    async upload(datasetId, bytes, filename) {
      const documents = await ragflow.uploadDocument(
        await ragflow.loadRagflowConfig(),
        datasetId,
        new Blob([Uint8Array.from(bytes).buffer], { type: 'text/csv;charset=utf-8' }),
        filename
      )
      const document = documents[0]
      if (!document) throw new Error('RAGFlow upload returned no document')
      return document.id
    },
    async parse(datasetId, documentId) {
      await ragflow.parseDocuments(await ragflow.loadRagflowConfig(), datasetId, [documentId])
    },
    async status(datasetId, documentId) {
      return ragflow.getDocumentParseStatus(
        await ragflow.loadRagflowConfig(),
        datasetId,
        documentId
      )
    },
    async disable(datasetId, documentId) {
      await ragflow.updateDocumentEnabled(
        await ragflow.loadRagflowConfig(),
        datasetId,
        documentId,
        false
      )
    },
    async delete(datasetId, documentId) {
      await ragflow.deleteDocument(await ragflow.loadRagflowConfig(), datasetId, documentId)
    },
    async stop(datasetId, documentId) {
      await ragflow.stopDocumentsParsing(await ragflow.loadRagflowConfig(), datasetId, [documentId])
    },
  }
  return new QaSyncWorker({
    repository: production.qaSyncRepository,
    ragflow: client,
    lock: production.qaSyncAdvisoryLock,
    now: () => new Date(),
    sleep: (milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        const timer = setTimeout(resolve, milliseconds)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      }),
    pollIntervalMs: 2_000,
    pollTimeoutMs: 120_000,
  })
}
