/**
 * Shared completion logic for async tool callbacks.
 *
 * Invoked by the HTTP callback route once a tool (pod wrapper, api self-post, or
 * http relay) reports its result. Steps: finalize the raw result → flip the
 * matching `pending` work-log row to terminal (First-Wins) → tear down the pod →
 * and, once no async calls remain pending for the node's task, resume the SOP.
 *
 * Idempotent: a duplicate / late callback finds no pending row and is a no-op.
 */
import { createLogger } from '@crewmeld/logger'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { completeToolCallLog, type TerminalApplyResult } from './async-tool-log'
import { finalizeToolResult, type RawToolEnvelope } from './finalize-tool-result'
import { cancelAsyncToolWatchdog } from './queue'

const logger = createLogger('ToolCallbackHandler')

/**
 * Shared tail after a tool call reaches a terminal state (via callback or
 * watchdog): tear down the pod, and resume the SOP once the node's whole round
 * has completed. Returns whether a resume was triggered.
 */
export async function afterToolCallTerminal(
  executionId: string,
  applied: TerminalApplyResult
): Promise<boolean> {
  if (!applied.applied) return false

  if (applied.sandboxId) {
    try {
      const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
      await getOpenSandboxClient().destroy(applied.sandboxId)
    } catch (e) {
      logger.warn('Failed to destroy async tool sandbox', {
        executionId,
        sandboxId: applied.sandboxId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (applied.remainingPending === 0 && applied.taskId) {
    const taskId = applied.taskId
    const { resumeSopFromAsyncTool } = await import('./engine')
    void resumeSopFromAsyncTool(executionId, taskId).catch((err) => {
      logger.error('Async-tool SOP resume failed', {
        executionId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return true
  }
  return false
}

export interface ToolCallbackBody {
  callId: string
  status: 'completed' | 'failed'
  result?: unknown
  error?: string
}

export interface ToolCallbackOutcome {
  ok: boolean
  /** 'finalized' applied this callback; 'duplicate' means the row was already terminal. */
  state: 'finalized' | 'duplicate'
  resumed: boolean
}

/** Derive the public download-url prefix the same way the node executor does. */
function sopFileUrlPrefix(executionId: string): string {
  const appBaseUrl = getBaseUrl().replace(/\/$/, '')
  return `${appBaseUrl}/api/sop/${executionId}/files`
}

export async function handleToolCallback(
  executionId: string,
  body: ToolCallbackBody
): Promise<ToolCallbackOutcome> {
  const raw: RawToolEnvelope =
    body.status === 'completed'
      ? { success: true, result: body.result }
      : { success: false, error: body.error ?? 'Unknown error' }

  const finalized = await finalizeToolResult(raw, {
    sopExecutionId: executionId,
    sopFileUrlPrefix: sopFileUrlPrefix(executionId),
  })

  const applied = await completeToolCallLog(body.callId, finalized)
  if (!applied.applied) {
    // Duplicate / late / unknown callback — already terminal, nothing to do.
    return { ok: true, state: 'duplicate', resumed: false }
  }

  // The callback won the race against the watchdog — cancel its timer.
  if (applied.watchdogJobId) {
    await cancelAsyncToolWatchdog(applied.watchdogJobId)
  }

  const resumed = await afterToolCallTerminal(executionId, applied)
  return { ok: true, state: 'finalized', resumed }
}
