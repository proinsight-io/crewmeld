'use client'

import type React from 'react'
import { ListTree, Loader2 } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { defaultTranslate } from '../tool-info'
import type { ToolProps } from './registry'

/**
 * Renderer for the `task` tool (sub-agent invocation).
 * Always single-line. Shows a spinner while running.
 */
export function taskTool(props: ToolProps): React.JSX.Element {
  const { input, status, t = defaultTranslate } = props

  const subagentType = input.subagent_type !== undefined ? String(input.subagent_type) : ''
  const title = subagentType
    ? subagentType.charAt(0).toUpperCase() + subagentType.slice(1)
    : t('devStudio.opencode.tool.task')

  const description = input.description !== undefined ? String(input.description) : undefined
  const isRunning = status === 'running'

  const spinnerAction = isRunning ? (
    <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
  ) : undefined

  return (
    <BasicTool
      icon={ListTree}
      trigger={{ title, subtitle: description, action: spinnerAction }}
      status={status}
      hideDetails
      data-testid='opencode-message:tool:task'
    />
  )
}
