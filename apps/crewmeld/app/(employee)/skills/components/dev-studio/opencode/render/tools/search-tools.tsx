'use client'

import type React from 'react'
import { List, Search } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { OpencodeMarkdown } from '../markdown'
import { defaultTranslate, getDirectory } from '../tool-info'
import type { ToolProps } from './registry'

/**
 * Renderer for the `list` tool — lists directory contents.
 */
export function listTool(props: ToolProps): React.JSX.Element {
  const { input, output, status, hideDetails, t = defaultTranslate } = props

  const path = input.path !== undefined ? String(input.path) : undefined
  const subtitle = path ? getDirectory(path) || path : undefined

  return (
    <BasicTool
      icon={List}
      trigger={{ title: t('devStudio.opencode.tool.list'), subtitle }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:list'
    >
      {output && <OpencodeMarkdown text={output} />}
    </BasicTool>
  )
}

/**
 * Renderer for the `glob` tool — searches files by pattern.
 */
export function globTool(props: ToolProps): React.JSX.Element {
  const { input, output, status, hideDetails } = props

  const path = input.path !== undefined ? String(input.path) : undefined
  const pattern = input.pattern !== undefined ? String(input.pattern) : undefined

  const subtitle = path ? getDirectory(path) || path : undefined
  const args = pattern ? [pattern] : undefined

  return (
    <BasicTool
      icon={Search}
      trigger={{ title: 'Glob', subtitle, args }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:glob'
    >
      {output && <OpencodeMarkdown text={output} />}
    </BasicTool>
  )
}

/**
 * Renderer for the `grep` tool — searches file contents by regex pattern.
 */
export function grepTool(props: ToolProps): React.JSX.Element {
  const { input, output, status, hideDetails } = props

  const path = input.path !== undefined ? String(input.path) : undefined
  const pattern = input.pattern !== undefined ? String(input.pattern) : undefined
  const include = input.include !== undefined ? String(input.include) : undefined

  const subtitle = path ? getDirectory(path) || path : undefined
  const args: string[] = []
  if (pattern) args.push(pattern)
  if (include) args.push(include)

  return (
    <BasicTool
      icon={Search}
      trigger={{ title: 'Grep', subtitle, args: args.length > 0 ? args : undefined }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:grep'
    >
      {output && <OpencodeMarkdown text={output} />}
    </BasicTool>
  )
}
