/**
 * BullMQ worker that durably runs an async **api** / **http (long-running)** tool call.
 *
 * The dispatched job lives in Redis, so it survives a BFF restart: on restart the
 * worker re-attaches and runs the tool here, closing the gap a BFF-memory-bound
 * detached promise left (the SOP would otherwise hang until the watchdog
 * timeout). Completion is applied in-process via {@link handleToolCallback} —
 * no HTTP round-trip / token needed, since the worker runs inside the BFF.
 *
 * At-most-once: the queue uses `attempts: 1` and the worker `maxStalledCount: 0`,
 * so a crash mid-run fails the job cleanly (the queue's `failed` handler reports
 * it) rather than re-running a tool that may have side effects.
 */
import { createLogger } from '@crewmeld/logger'
import type { AsyncToolExecPayload } from '@/types/sop'
import { runAsyncToolExec } from '../async-tool-exec-run'

const logger = createLogger('AsyncToolExecWorker')

/**
 * Run one dispatched api/http tool call and drive its SOP resume.
 *
 * @param payload - Serialized dispatch context from {@link getAsyncToolExecQueue}.
 */
export async function processAsyncToolExec(payload: AsyncToolExecPayload): Promise<void> {
  logger.info('Running async tool exec job', {
    executionId: payload.executionId,
    callId: payload.callId,
    kind: payload.kind,
    toolId: payload.toolId,
  })
  // Never throws — tool/transport errors are captured as a failed callback body.
  const body = await runAsyncToolExec(payload)
  // A throw here (e.g. DB error) fails the job, and the queue's `failed` handler
  // turns it into a failed callback so the SOP still resumes.
  const { handleToolCallback } = await import('../tool-callback-handler')
  await handleToolCallback(payload.executionId, body)
}
