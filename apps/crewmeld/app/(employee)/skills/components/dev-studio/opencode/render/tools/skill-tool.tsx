'use client'

import type React from 'react'
import { Brain } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { defaultTranslate } from '../tool-info'
import type { ToolProps } from './registry'

/**
 * Renderer for the `skill` tool.
 * Always single-line (hideDetails=true). Never renders output.
 */
export function skillTool(props: ToolProps): React.JSX.Element {
  const { input, status, t = defaultTranslate } = props

  const name = input.name !== undefined ? String(input.name) : t('devStudio.opencode.tool.skill')

  return (
    <BasicTool
      icon={Brain}
      trigger={{ title: name }}
      status={status}
      hideDetails
      data-testid={`opencode-message:skill:${name}`}
    />
  )
}
