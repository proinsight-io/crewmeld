/**
 * Heuristic fallback phase detector.
 *
 * Used by the chat pipeline when the AI has not yet emitted an explicit
 * `<phase>` marker (see `MarkerExtractor`). We inspect each SDK message
 * for canonical signals — a brainstorming Skill invocation, a Write to
 * a source file, a test runner Bash command, or the final result frame —
 * and propose the corresponding canonical phase identifier. Once the AI
 * has set any phase value (passed in via `currentPhase`), we yield to it.
 */
import type { SDKMessage } from './schemas'

const CODE_FILE_RE = /\.(py|ts|js|tsx|jsx)$/i
const TEST_COMMAND_RE = /(pytest|vitest|unittest|pnpm\s+test|bun\s+test)/i

type ToolUseBlock = {
  type: 'tool_use'
  name: string
  input: unknown
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.type === 'tool_use' && typeof v.name === 'string'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function classifyToolUse(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (block.name === 'Skill') {
    const skill = typeof input.skill === 'string' ? input.skill : ''
    if (/brainstorm/i.test(skill)) return 'requirement'
  }
  if (block.name === 'Write') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : ''
    if (CODE_FILE_RE.test(filePath)) return 'coding'
  }
  if (block.name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (TEST_COMMAND_RE.test(command)) return 'testing'
  }
  return null
}

/**
 * Returns a heuristic phase label for the supplied message, or null if no
 * signal applies. When `currentPhase` is non-null the AI is presumed to be
 * driving phases explicitly and this detector stays silent.
 */
export function detectPhase(message: SDKMessage, currentPhase: string | null): string | null {
  if (currentPhase) return null

  // Used to map result frames to a synthetic 'done' phase here, but that
  // polluted phaseHistory: every turn that ended before the AI explicitly
  // emitted <phase> stamped 'done' into the timeline, leading to bogus
  // orderings like verification → done → adoption with the middle step
  // ticked done even though the AI never said it was done. Leave result
  // frames alone — phase advancement is the AI's job via <phase> markers.

  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (isToolUseBlock(block)) {
      const detected = classifyToolUse(block)
      if (detected) return detected
    }
  }
  return null
}
