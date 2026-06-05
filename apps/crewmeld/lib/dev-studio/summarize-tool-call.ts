/**
 * Pure helpers to turn an SDK `tool_use` frame into a one-line summary the
 * chat UI can render in the collapsed details summary, instead of dumping
 * the entire JSON input.
 *
 * The returned `labelKey` is an i18n key resolved by the caller; `primary`
 * is the most useful single parameter (file basename, command preview, etc.)
 * already trimmed for display.
 */

export interface ToolCallSummary {
  /** Single-character emoji shown left of the label. */
  icon: string
  /**
   * i18n key for the action verb (e.g. `'devStudio.chat.toolLabel.read'`).
   * `null` means we don't have a specific mapping — caller should fall back
   * to the generic `'devStudio.chat.toolCall'` template that just shows the
   * raw tool name.
   */
  labelKey: string | null
  /** Trimmed primary parameter (file basename / command / pattern / etc.). */
  primary: string | null
}

const MAX_PRIMARY_LEN = 60

function truncate(s: string, n = MAX_PRIMARY_LEN): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= n) return collapsed
  return `${collapsed.slice(0, n)}…`
}

function basename(p: string): string {
  // Strip trailing slashes then split on either separator.
  const trimmed = p.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function getString(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function summarizePath(input: unknown, icon: string, labelKey: string): ToolCallSummary {
  const fp = getString(input, 'file_path')
  return { icon, labelKey, primary: fp ? basename(fp) : null }
}

/**
 * Map a tool name + its raw input into a display summary. The mapping covers
 * the tools we actually expect to surface inside a dev-studio session; any
 * unknown name falls through to the generic 'call {name}' template.
 */
export function summarizeToolCall(name: string, input: unknown): ToolCallSummary {
  switch (name) {
    case 'TaskCreate':
      return {
        icon: '📋',
        labelKey: 'devStudio.chat.toolLabel.taskCreate',
        primary: getString(input, 'subject')
          ? truncate(getString(input, 'subject') as string)
          : null,
      }
    case 'TaskUpdate':
      return {
        icon: '📋',
        labelKey: 'devStudio.chat.toolLabel.taskUpdate',
        primary: getString(input, 'status'),
      }
    case 'TodoWrite': {
      const todos = (input as { todos?: unknown[] } | null)?.todos
      const count = Array.isArray(todos) ? String(todos.length) : null
      return { icon: '📋', labelKey: 'devStudio.chat.toolLabel.todoWrite', primary: count }
    }
    case 'Read':
      return summarizePath(input, '📄', 'devStudio.chat.toolLabel.read')
    case 'Write':
      return summarizePath(input, '📝', 'devStudio.chat.toolLabel.write')
    case 'Edit':
      return summarizePath(input, '✏️', 'devStudio.chat.toolLabel.edit')
    case 'MultiEdit':
      return summarizePath(input, '✏️', 'devStudio.chat.toolLabel.multiEdit')
    case 'NotebookEdit':
      return summarizePath(input, '✏️', 'devStudio.chat.toolLabel.notebookEdit')
    case 'Bash': {
      const desc = getString(input, 'description')
      const cmd = getString(input, 'command')
      const text = desc ?? cmd
      return {
        icon: '▶',
        labelKey: 'devStudio.chat.toolLabel.bash',
        primary: text ? truncate(text) : null,
      }
    }
    case 'BashOutput':
      return {
        icon: '📺',
        labelKey: 'devStudio.chat.toolLabel.bashOutput',
        primary: getString(input, 'shell_id'),
      }
    case 'KillShell':
      return {
        icon: '🛑',
        labelKey: 'devStudio.chat.toolLabel.killShell',
        primary: getString(input, 'shell_id'),
      }
    case 'Grep': {
      const p = getString(input, 'pattern')
      return {
        icon: '🔍',
        labelKey: 'devStudio.chat.toolLabel.grep',
        primary: p ? truncate(p) : null,
      }
    }
    case 'Glob': {
      const p = getString(input, 'pattern')
      return {
        icon: '🗂',
        labelKey: 'devStudio.chat.toolLabel.glob',
        primary: p ? truncate(p) : null,
      }
    }
    // SDK calls it `Task`; some plugin layers expose it as `Agent`.
    case 'Agent':
    case 'Task': {
      const desc = getString(input, 'description')
      return {
        icon: '🤖',
        labelKey: 'devStudio.chat.toolLabel.agent',
        primary: desc ? truncate(desc) : null,
      }
    }
    case 'WebFetch': {
      const url = getString(input, 'url')
      return {
        icon: '🌐',
        labelKey: 'devStudio.chat.toolLabel.webFetch',
        primary: url ? truncate(url) : null,
      }
    }
    case 'WebSearch': {
      const q = getString(input, 'query')
      return {
        icon: '🔎',
        labelKey: 'devStudio.chat.toolLabel.webSearch',
        primary: q ? truncate(q) : null,
      }
    }
    default:
      return { icon: '🔧', labelKey: null, primary: null }
  }
}
