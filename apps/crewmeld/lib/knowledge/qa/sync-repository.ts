import { db } from '@crewmeld/db'
import {
  knowledgeBases,
  qaCsvBatches,
  qaDocumentVersions,
  qaQuestions,
  qaSyncJobs,
} from '@crewmeld/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { renderQaBatchCsv } from './csv-renderer'
import type { QaSyncReason } from './sync-service'
import type { QaBatchLock, QaSyncRepository, QaSyncSnapshot } from './sync-worker'

export function createQaSyncRepository(database: typeof db): QaSyncRepository & {
  enqueue(batchId: string, reason: QaSyncReason): Promise<string>
  getJob(id: string): Promise<{ id: string; batchId: string; reason: string } | null>
  listDispatchableJobs(): Promise<Array<{ id: string }>>
} {
  return {
    async readSnapshot(batchId): Promise<QaSyncSnapshot> {
      const [batch] = await database
        .select({
          batchId: qaCsvBatches.id,
          datasetId: knowledgeBases.ragflowDatasetId,
          activeVersionId: qaCsvBatches.activeVersionId,
        })
        .from(qaCsvBatches)
        .innerJoin(knowledgeBases, eq(qaCsvBatches.knowledgeBaseId, knowledgeBases.id))
        .where(eq(qaCsvBatches.id, batchId))
        .limit(1)
      if (!batch) throw new Error(`QA batch not found: ${batchId}`)
      const rows = await database
        .select({
          id: qaQuestions.id,
          question: qaQuestions.question,
          answer: qaQuestions.answer,
          enabled: qaQuestions.enabled,
          sortOrder: qaQuestions.sortOrder,
          tags: qaQuestions.tags,
        })
        .from(qaQuestions)
        .where(eq(qaQuestions.batchId, batchId))
        .orderBy(asc(qaQuestions.sortOrder), asc(qaQuestions.id))
      let activeVersion: QaSyncSnapshot['activeVersion'] = null
      if (batch.activeVersionId) {
        const [version] = await database
          .select({
            id: qaDocumentVersions.id,
            checksum: qaDocumentVersions.checksum,
            remoteDocumentId: qaDocumentVersions.ragflowDocumentId,
          })
          .from(qaDocumentVersions)
          .where(eq(qaDocumentVersions.id, batch.activeVersionId))
          .limit(1)
        if (version?.remoteDocumentId)
          activeVersion = {
            id: version.id,
            checksum: version.checksum,
            remoteDocumentId: version.remoteDocumentId,
          }
      }
      return { batchId, datasetId: batch.datasetId, rows, activeVersion }
    },
    async createPending(batchId, checksum, filename, jobId) {
      const [existing] = await database
        .select({
          id: qaDocumentVersions.id,
          filename: qaDocumentVersions.filename,
          remoteDocumentId: qaDocumentVersions.ragflowDocumentId,
        })
        .from(qaDocumentVersions)
        .where(
          and(eq(qaDocumentVersions.batchId, batchId), eq(qaDocumentVersions.checksum, checksum))
        )
        .orderBy(asc(qaDocumentVersions.createdAt))
        .limit(1)
      const versionId = existing?.id ?? crypto.randomUUID()
      if (existing) {
        await database
          .update(qaDocumentVersions)
          .set({ status: 'syncing', error: null, updatedAt: new Date() })
          .where(eq(qaDocumentVersions.id, versionId))
      } else {
        await database.insert(qaDocumentVersions).values({
          id: versionId,
          batchId,
          checksum,
          filename,
          status: 'syncing',
          cleanupStatus: 'pending',
        })
      }
      await database
        .update(qaSyncJobs)
        .set({
          status: 'syncing',
          attempts: sql`${qaSyncJobs.attempts} + 1`,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(qaSyncJobs.id, jobId))
      return {
        versionId,
        jobId,
        filename: existing?.filename ?? filename,
        remoteDocumentId: existing?.remoteDocumentId ?? null,
      }
    },
    async markRemoteDocument(versionId, remoteDocumentId) {
      await database
        .update(qaDocumentVersions)
        .set({ ragflowDocumentId: remoteDocumentId, updatedAt: new Date() })
        .where(eq(qaDocumentVersions.id, versionId))
    },
    async clearRemoteDocument(versionId) {
      await database
        .update(qaDocumentVersions)
        .set({ ragflowDocumentId: null, updatedAt: new Date() })
        .where(eq(qaDocumentVersions.id, versionId))
    },
    async markFailed(versionId, jobId, error) {
      await database.transaction(async (tx) => {
        await tx
          .update(qaDocumentVersions)
          .set({ status: 'failed', error, updatedAt: new Date() })
          .where(eq(qaDocumentVersions.id, versionId))
        await tx
          .update(qaSyncJobs)
          .set({ status: 'failed', error, updatedAt: new Date() })
          .where(eq(qaSyncJobs.id, jobId))
      })
    },
    async activate(input) {
      await database.transaction(async (tx) => {
        await tx
          .update(qaDocumentVersions)
          .set({
            status: 'active',
            parsedAt: input.at,
            syncedAt: input.at,
            error: null,
            cleanupStatus: 'not_required',
            updatedAt: input.at,
          })
          .where(eq(qaDocumentVersions.id, input.versionId))
        await tx
          .update(qaCsvBatches)
          .set({ activeVersionId: input.versionId, updatedAt: input.at })
          .where(eq(qaCsvBatches.id, input.batchId))
        if (input.oldVersionId)
          await tx
            .update(qaDocumentVersions)
            .set({ status: 'superseded', cleanupStatus: 'pending', updatedAt: input.at })
            .where(eq(qaDocumentVersions.id, input.oldVersionId))
        await tx
          .update(qaSyncJobs)
          .set({ status: 'active', error: null, updatedAt: input.at })
          .where(eq(qaSyncJobs.id, input.jobId))
      })
    },
    async recordCleanupFailure(versionId, error) {
      await database
        .update(qaDocumentVersions)
        .set({ cleanupStatus: 'failed', cleanupError: error, updatedAt: new Date() })
        .where(eq(qaDocumentVersions.id, versionId))
    },
    async markCleanupComplete(versionId) {
      await database
        .update(qaDocumentVersions)
        .set({ cleanupStatus: 'complete', cleanupError: null, updatedAt: new Date() })
        .where(eq(qaDocumentVersions.id, versionId))
    },
    async markNoop(jobId) {
      await database
        .update(qaSyncJobs)
        .set({ status: 'active', error: null, updatedAt: new Date() })
        .where(eq(qaSyncJobs.id, jobId))
    },
    async markCancelled(versionId, jobId, cleanupError) {
      await database.transaction(async (tx) => {
        await tx
          .update(qaDocumentVersions)
          .set({
            status: 'failed',
            error: 'Synchronization cancelled',
            cleanupStatus: cleanupError ? 'failed' : 'complete',
            cleanupError,
            updatedAt: new Date(),
          })
          .where(eq(qaDocumentVersions.id, versionId))
        await tx
          .update(qaSyncJobs)
          .set({ status: 'pending', error: 'Synchronization cancelled', updatedAt: new Date() })
          .where(eq(qaSyncJobs.id, jobId))
      })
    },
    async enqueue(batchId, reason) {
      const snapshot = await this.readSnapshot(batchId)
      const { checksum } = renderQaBatchCsv(snapshot.rows)
      const idempotencyKey = `${batchId}:${checksum}`
      const id = crypto.randomUUID()
      await database
        .insert(qaSyncJobs)
        .values({ id, batchId, reason, idempotencyKey })
        .onConflictDoNothing({ target: qaSyncJobs.idempotencyKey })
      const [job] = await database
        .select({ id: qaSyncJobs.id })
        .from(qaSyncJobs)
        .where(eq(qaSyncJobs.idempotencyKey, idempotencyKey))
        .limit(1)
      if (!job) throw new Error('QA sync enqueue returned no job')
      return job.id
    },
    async getJob(id) {
      const [job] = await database
        .select({ id: qaSyncJobs.id, batchId: qaSyncJobs.batchId, reason: qaSyncJobs.reason })
        .from(qaSyncJobs)
        .where(eq(qaSyncJobs.id, id))
        .limit(1)
      return job ?? null
    },
    async listDispatchableJobs() {
      return database
        .select({ id: qaSyncJobs.id })
        .from(qaSyncJobs)
        .where(sql`${qaSyncJobs.status} in ('pending', 'syncing', 'failed')`)
    },
  }
}

export function createQaAdvisoryLock(database: typeof db): QaBatchLock {
  return {
    async withBatchLock<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${batchId}, 0))`)
        return operation()
      })
    },
  }
}

export const qaSyncRepository = createQaSyncRepository(db)
export const qaSyncAdvisoryLock = createQaAdvisoryLock(db)
