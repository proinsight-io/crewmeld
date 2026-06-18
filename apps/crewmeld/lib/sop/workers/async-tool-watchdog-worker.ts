/**
 * Async-tool watchdog worker.
 *
 * Fires when a dispatched async tool call has not called back within the
 * watchdog window — the liveness guard against a tool that crashed, whose pod
 * died, or whose callback never reached the BFF. It fails the still-pending
 * call (First-Wins: a no-op if the real callback already won the race), tears
 * down the pod, and resumes the SOP if the node's round is otherwise complete,
 * so the execution never hangs in paused_for_tool forever.
 *
 * The window is a liveness ceiling, not a duration limit: it should track the
 * pod TTL (CREWMELD_SANDBOX_TTL_SECONDS), since once the pod is gone no callback
 * can ever arrive.
 */
import { createLogger } from '@crewmeld/logger'
import type { AsyncToolWatchdogPayload } from '@/types/sop'
import { failToolCallLog } from '../async-tool-log'
import { afterToolCallTerminal } from '../tool-callback-handler'

const logger = createLogger('AsyncToolWatchdog')

export async function processAsyncToolWatchdog(payload: AsyncToolWatchdogPayload): Promise<void> {
  const { executionId, callId } = payload

  const applied = await failToolCallLog(
    callId,
    'Async tool timed out: no callback received within the watchdog window'
  )
  if (!applied.applied) {
    // The real callback already finalized this call — watchdog lost the race.
    return
  }

  logger.warn('Async tool watchdog fired; failing stuck call', {
    executionId,
    callId,
    taskId: applied.taskId,
  })

  await afterToolCallTerminal(executionId, applied)
}
