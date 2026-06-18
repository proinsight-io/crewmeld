/**
 * Pure reconstruction of a suspended node's LLM conversation middle from its
 * journaled async tool calls. DB-free by design so it is unit-testable in
 * isolation; the IO wrapper lives in `rebuild-messages-from-worklogs.ts`.
 *
 * See that wrapper's header for the full rationale (resume without persisting
 * the raw message array; no extra LLM request).
 */
import type { AsyncToolCallMeta, ChatMessage } from './tool-loop-types'

export interface RebuiltToolExchange {
  /** Assistant/tool message pairs for every completed round, in order. */
  messages: ChatMessage[]
  /** Highest round seen; the loop resumes at lastRound + 1. -1 when no rows. */
  lastRound: number
}

/**
 * Turn ordered async tool-call metadata into OpenAI messages. Rows must already
 * be filtered to one node's calls and ordered by creation time. Grouped by
 * `round` so a multi-tool-call round yields a single assistant message with all
 * its tool_calls followed by each tool result — preserving OpenAI's "every
 * tool_call needs a matching tool message" rule.
 */
export function reconstructToolExchange(metas: AsyncToolCallMeta[]): RebuiltToolExchange {
  const byRound = new Map<number, AsyncToolCallMeta[]>()
  for (const m of metas) {
    const list = byRound.get(m.round)
    if (list) list.push(m)
    else byRound.set(m.round, [m])
  }

  const messages: ChatMessage[] = []
  let lastRound = -1

  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const calls = byRound.get(round) ?? []
    lastRound = Math.max(lastRound, round)

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.callId,
        type: 'function' as const,
        function: { name: c.toolName, arguments: JSON.stringify(c.input ?? {}) },
      })),
    })

    for (const c of calls) {
      const content =
        c.resultContent ?? (c.output !== undefined ? JSON.stringify(c.output) : '') ?? ''
      messages.push({
        role: 'tool',
        content,
        tool_call_id: c.callId,
        name: c.toolName,
      })
    }
  }

  return { messages, lastRound }
}
