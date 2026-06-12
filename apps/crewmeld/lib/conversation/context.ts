/**
 * Context window management — sliding window + token budget
 */

import type { ContextWindowConfig, EngineMessage } from './types'

const DEFAULT_CONFIG: ContextWindowConfig = {
  maxTokens: 8000,
  reservedForResponse: 2000,
  reservedForTools: 500,
}

/**
 * Estimate text token count
 * Chinese approx 1.5 tokens/char, English approx 0.25 tokens/word (4 chars per token)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // CJK Unified Ideographs range
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.5
    } else if (code >= 0x3000 && code <= 0x303f) {
      // CJK punctuation
      tokens += 1.5
    } else {
      tokens += 0.25
    }
  }

  return Math.ceil(tokens)
}

/**
 * Estimate message token count (including role overhead)
 */
function estimateMessageTokens(msg: EngineMessage): number {
  let tokens = 4 // role + message overhead
  if (msg.content) {
    tokens += estimateTokens(msg.content)
  }
  if (msg.tool_calls) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls))
  }
  if (msg.tool_call_id) {
    tokens += 4 // tool_call_id overhead
  }
  return tokens
}

/**
 * Strip raw tool-call structure from the history fed to the LLM.
 *
 * Keeps user messages and assistant summaries (natural-language replies,
 * including expired-hint placeholders); drops `tool` result messages and
 * assistant messages that carry `tool_calls`.
 *
 * The summaries have already passed through the engine's 5-minute expiry
 * transform, so stale tool-derived answers stay neutralised (the model is still
 * forced to re-invoke a tool when its summary is expired). This step only
 * removes the structural tool-call payloads — e.g. the `sop_<id>` function name
 * of a permission-filtered SOP — that would otherwise prime the model to echo a
 * tool call back to the user as raw JSON text.
 */
export function stripToolStructureFromHistory(messages: EngineMessage[]): EngineMessage[] {
  return messages.filter(
    (m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)
  )
}

/**
 * Build context window — trace back from newest messages, preserve tool_call↔tool_result pair integrity
 */
export function buildContextWindow(
  messages: EngineMessage[],
  systemPrompt: string,
  config: ContextWindowConfig = DEFAULT_CONFIG
): EngineMessage[] {
  const systemTokens = estimateTokens(systemPrompt) + 4
  const budget =
    config.maxTokens - config.reservedForResponse - config.reservedForTools - systemTokens

  if (budget <= 0 || messages.length === 0) {
    return []
  }

  // Reverse iterate from newest to oldest
  const selected: EngineMessage[] = []
  let usedTokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const msgTokens = estimateMessageTokens(msg)

    if (usedTokens + msgTokens > budget) {
      break
    }

    selected.unshift(msg)
    usedTokens += msgTokens
  }

  // Ensure tool_call↔tool_result pairs are complete
  return ensurePairIntegrity(selected)
}

/**
 * Ensure tool_call and tool_result messages appear in pairs and adjacent
 *
 * Fix three types of issues:
 * 1. Orphaned tool result (assistant tool_call truncated) -> remove
 * 2. Orphaned tool_calls (tool result not saved / truncated) -> strip tool_calls
 * 3. tool result not adjacent to assistant (other messages inserted) -> reorder to make adjacent
 * 4. Empty content assistant messages after stripping tool_calls -> remove
 */
function ensurePairIntegrity(messages: EngineMessage[]): EngineMessage[] {
  // Step 1: Collect bidirectional ID mapping
  const toolResultIds = new Set<string>()
  const toolCallIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id)
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIds.add(tc.id)
      }
    }
  }

  // Step 2: Remove orphaned tool result (no matching assistant)
  let filtered = messages.filter((msg) => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      return toolCallIds.has(msg.tool_call_id)
    }
    return true
  })

  // Step 3: Strip orphaned tool_calls (no matching tool result)
  filtered = filtered.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      const validCalls = msg.tool_calls.filter((tc) => toolResultIds.has(tc.id))
      if (validCalls.length === 0) {
        const { tool_calls: _, ...rest } = msg
        return { ...rest, content: msg.content ?? '' }
      }
      if (validCalls.length < msg.tool_calls.length) {
        return { ...msg, tool_calls: validCalls }
      }
    }
    return msg
  })

  // Step 4: Remove empty assistant messages after stripping tool_calls
  filtered = filtered.filter((msg) => {
    if (msg.role === 'assistant' && !msg.tool_calls) {
      return (msg.content ?? '').trim().length > 0
    }
    return true
  })

  // Step 5: Reorder — ensure tool result follows its corresponding assistant message
  // Index all tool messages by tool_call_id, then insert at correct position during iteration
  const toolMsgsByCallId = new Map<string, EngineMessage>()
  for (const msg of filtered) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolMsgsByCallId.set(msg.tool_call_id, msg)
    }
  }

  const result: EngineMessage[] = []
  const placedToolCallIds = new Set<string>()

  for (const msg of filtered) {
    // Skip tool messages (will be inserted uniformly after assistant)
    if (msg.role === 'tool' && msg.tool_call_id) {
      continue
    }

    result.push(msg)

    // If assistant with tool_calls, insert all its tool results right after
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const toolMsg = toolMsgsByCallId.get(tc.id)
        if (toolMsg) {
          result.push(toolMsg)
          placedToolCallIds.add(tc.id)
        }
      }
    }
  }

  return result
}
