'use client'

import type React from 'react'
import { AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { GenericTool } from '../basic-tool'
import { getToolInfo, type Translate } from '../tool-info'
import { bashTool } from './bash-tool'
import { editTool, writeTool } from './edit-write-tools'
import { questionTool } from './question-tool'
import { readTool } from './read-tool'
import { globTool, grepTool, listTool } from './search-tools'
import { skillTool } from './skill-tool'
import { taskTool } from './task-tool'

/**
 * Props passed to every per-tool renderer function.
 */
export interface ToolProps {
  /** The tool name identifier (e.g. `bash`, `edit`). */
  tool: string
  /** Raw input payload for the tool call. */
  input: Record<string, unknown>
  /** Optional metadata attached to the tool result. */
  metadata: Record<string, unknown>
  /** Raw text output / result from the tool. */
  output?: string
  /** Execution status: `pending` | `running` | `completed` | `error`. */
  status?: string
  /** When true, render as a single non-expandable row. */
  hideDetails?: boolean
  /** Whether the collapsible content is open by default. */
  defaultOpen?: boolean
  /**
   * Locale-aware translate function, injected by {@link ToolPartDisplay}.
   * Optional only so renderers invoked directly (unit tests) fall back to the
   * default-locale translator; production always receives the live `t`.
   */
  t?: Translate
}

/** Mapping from tool name to its dedicated renderer function. */
const TOOL_RENDERERS: Record<string, (p: ToolProps) => React.JSX.Element | null> = {
  bash: bashTool,
  skill: skillTool,
  question: questionTool,
  read: readTool,
  list: listTool,
  glob: globTool,
  grep: grepTool,
  task: taskTool,
  edit: editTool,
  write: writeTool,
  // apply_patch maps to editTool as a best-effort fallback
  apply_patch: editTool,
}

/**
 * A red-bordered error card shown when a tool call ends with `status === 'error'`.
 */
export function ToolErrorCard({
  tool,
  message,
}: {
  tool: string
  message: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const info = getToolInfo(tool, undefined, undefined, t)

  return (
    <div
      data-testid={`opencode-message:tool-error:${tool}`}
      className='flex items-start gap-2 rounded border border-red-400 bg-red-50 px-3 py-2 text-sm dark:bg-red-950/30'
    >
      <AlertCircle className='mt-0.5 h-4 w-4 shrink-0 text-red-500' />
      <div className='min-w-0'>
        <div className='font-medium text-red-700 dark:text-red-400'>{info.title}</div>
        {message && (
          <div className='mt-0.5 text-xs text-red-600 dark:text-red-300 break-words'>{message}</div>
        )}
      </div>
    </div>
  )
}

/**
 * True when a tool error is a transient argument-validation failure that
 * opencode retries by feeding the error back to the model (so the next step
 * usually emits a corrected call). Used to suppress the error card for such
 * self-recovering attempts. Matches on the model-facing validation phrasings.
 */
function isTransientInputError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('json parsing failed') ||
    m.includes('unable to parse json') ||
    m.includes('json parse error') ||
    m.includes('invalid input for tool')
  )
}

/**
 * Dispatch entry point — selects and renders the correct tool component.
 *
 * Rules (in priority order):
 * 1. `todowrite` → always hidden (returns null).
 * 2. `question` when pending/running → hidden until answered (returns null).
 * 3. `status === 'error'` → renders {@link ToolErrorCard} (except transient
 *    `question` validation errors, which self-recover and are hidden).
 * 4. Known tool in {@link TOOL_RENDERERS} → delegate to its renderer.
 * 5. Unknown tool → renders {@link GenericTool}.
 */
export function ToolPartDisplay(props: Omit<ToolProps, 't'>): React.JSX.Element | null {
  const { t } = useTranslation()
  const { tool, input, status, output, hideDetails } = props

  const lc = tool.toLowerCase()

  // Rule 1: todowrite is always hidden.
  if (lc === 'todowrite') return null

  // Rule 2: question is hidden while still pending/running.
  if (lc === 'question' && (status === 'pending' || status === 'running')) return null

  // Rule 3: error status → error card. Exception: a `question` call that failed
  // schema/JSON validation is transient — opencode feeds the validation error
  // back to the model, which re-emits a corrected call on the next step (the
  // successful card then renders). Hiding this attempt avoids flashing a scary
  // red error for something that self-recovers; a truly terminal turn failure
  // still surfaces via the `session.error` banner.
  if (status === 'error') {
    const message = output ?? ''
    if (lc === 'question' && isTransientInputError(message)) return null
    return <ToolErrorCard tool={tool} message={message} />
  }

  // Rule 4: dedicated renderer. Inject the translate fn — renderers are called
  // as plain functions (not React components), so they cannot call hooks
  // themselves and receive `t` through props instead.
  const Renderer = TOOL_RENDERERS[lc] ?? null
  if (Renderer) return Renderer({ ...props, t })

  // Rule 5: generic fallback.
  return <GenericTool tool={tool} input={input} status={status} hideDetails={hideDetails} t={t} />
}
