/**
 * Shared types for the suspendable SOP tool loop.
 *
 * The digital-employee LLM loop can suspend mid-flight when it dispatches an
 * async tool, then resume after the tool's callback arrives. To resume without
 * persisting the raw OpenAI message array, the loop's conversation is
 * reconstructed from `work_logs` (one row per tool call). These types describe
 * (a) the OpenAI-shaped chat message we rebuild and feed back to the model, and
 * (b) the structured metadata each async tool-call log row carries so the
 * callback can finalize it and the resume can rebuild from it.
 */

/** OpenAI-compatible chat message (mirrors llm-tool-executor's internal shape). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

/** Lifecycle of an async tool call, tracked entirely in the work-log row. */
export type AsyncToolStatus = 'pending' | 'completed' | 'failed'

/**
 * Structured metadata stored on a `tool_call` work-log row for an async tool
 * call. Written as `pending` at dispatch, then finalized to `completed` /
 * `failed` by the callback. Holds everything the callback needs to finalize the
 * result and everything the resume needs to rebuild the conversation — so no
 * separate table is required.
 */
export interface AsyncToolCallMeta {
  /** True marks this log row as an async-tool call (vs a legacy inline one). */
  async: true
  status: AsyncToolStatus
  /** Stable id correlating dispatch ⇆ callback; also used as the tool_call_id on rebuild. */
  callId: string
  /** Zero-based LLM round this call was issued in (groups multi-call rounds on rebuild). */
  round: number
  toolName: string
  toolId: string
  instanceName: string
  /** Parsed tool arguments — reconstructs the assistant tool_call on resume. */
  input: Record<string, unknown>
  /** Owning SOP execution + node, for callback routing and watchdog cleanup. */
  executionId: string
  nodeId: string
  /** Finalized tool output object (set by the callback). */
  output?: unknown
  /** Exact string fed back to the LLM as the tool message content (set by the callback). */
  resultContent?: string
  /** Success flag (set by the callback). */
  success?: boolean
  /** Sandbox to tear down once the callback lands (pod tools only). */
  sandboxId?: string
  /** BullMQ watchdog job id, so the callback can cancel the timeout. */
  watchdogJobId?: string
}

/**
 * Outcome of running (or resuming) the tool loop for one node.
 * `done` → the LLM produced a final answer; `suspended` → one or more async
 * tools were dispatched and the SOP must pause until their callbacks land.
 */
export type ToolLoopOutcome =
  | {
      kind: 'done'
      summary: string | null
      rounds: number
      totalTokens: number
      error?: string
    }
  | {
      kind: 'suspended'
      /** Round whose tool calls were dispatched; callbacks resume from round+1. */
      round: number
      /** Number of async tool calls dispatched this round (all must complete to resume). */
      dispatched: number
    }
