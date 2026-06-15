/**
 * Detects file-related activity inside SDK messages so the UI can surface
 * manifest / README authoring progress and dependency-approval hints.
 *
 * Signals (highest priority first):
 * - A `Write` tool_use targeting `.crewmeld-studio/manifest.json` → `manifest-write`
 * - A `Write` tool_use targeting `.crewmeld-studio/README.md`    → `readme-write`
 * - Assistant text mentioning the word `manifest` (case-insensitive)
 *   → `keyword-mention` with subject `manifest`
 * - Assistant text mentioning the word `README` (case-insensitive)
 *   → `keyword-mention` with subject `readme`
 *
 * Only the first matching signal per message is returned. Write tool_uses
 * outrank keyword mentions because they are authoritative; keyword scans
 * are a softer pre-write hint.
 */
import type { SDKMessage } from './schemas'

export type FileActivity =
  | { type: 'manifest-write'; filePath: string }
  | { type: 'readme-write'; filePath: string }
  | { type: 'keyword-mention'; subject: 'manifest' | 'readme' }

const MANIFEST_PATH_FRAGMENT = '.crewmeld-studio/manifest.json'
const README_PATH_FRAGMENT = '.crewmeld-studio/README.md'
const MANIFEST_KEYWORD_RE = /manifest/i
const README_KEYWORD_RE = /README/i

type ToolUseBlock = { type: 'tool_use'; name: string; input: unknown }
type TextBlock = { type: 'text'; text: string }

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.type === 'tool_use' && typeof v.name === 'string'
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.type === 'text' && typeof v.text === 'string'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export class FileActivityDetector {
  /**
   * Inspect one SDK message and return the highest-priority activity signal,
   * or null when nothing actionable is present. Stateless — every call is
   * independent.
   */
  consume(message: SDKMessage): FileActivity | null {
    const content = Array.isArray(message.content) ? message.content : []

    for (const block of content) {
      if (!isToolUseBlock(block) || block.name !== 'Write') continue
      const input = asRecord(block.input)
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath.includes(MANIFEST_PATH_FRAGMENT)) {
        return { type: 'manifest-write', filePath }
      }
      if (filePath.includes(README_PATH_FRAGMENT)) {
        return { type: 'readme-write', filePath }
      }
    }

    for (const block of content) {
      if (!isTextBlock(block)) continue
      if (MANIFEST_KEYWORD_RE.test(block.text)) {
        return { type: 'keyword-mention', subject: 'manifest' }
      }
      if (README_KEYWORD_RE.test(block.text)) {
        return { type: 'keyword-mention', subject: 'readme' }
      }
    }

    return null
  }
}
