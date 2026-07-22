'use client'

import type React from 'react'
import { FileCode } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { DiffChanges } from '../diff-changes'
import { defaultTranslate, getFilename } from '../tool-info'
import type { ToolProps } from './registry'
import { BeforeAfterDiff, UnifiedDiff } from './unified-diff'

/** Narrows metadata.filediff to a typed shape. */
interface FileDiff {
  patch?: string
  additions?: number
  deletions?: number
  additionLines?: number
  deletionLines?: number
  before?: string
  after?: string
}

function toFileDiff(value: unknown): FileDiff {
  if (typeof value !== 'object' || value === null) return {}
  const v = value as Record<string, unknown>
  return {
    patch: typeof v['patch'] === 'string' ? v['patch'] : undefined,
    additions: typeof v['additions'] === 'number' ? v['additions'] : undefined,
    deletions: typeof v['deletions'] === 'number' ? v['deletions'] : undefined,
    additionLines: typeof v['additionLines'] === 'number' ? v['additionLines'] : undefined,
    deletionLines: typeof v['deletionLines'] === 'number' ? v['deletionLines'] : undefined,
    before: typeof v['before'] === 'string' ? v['before'] : undefined,
    after: typeof v['after'] === 'string' ? v['after'] : undefined,
  }
}

/**
 * Renderer for the `edit` tool.
 * Header: Edit + filename + DiffChanges.
 * Expandable: unified diff patch (colored lines) or before/after blocks.
 */
export function editTool(props: ToolProps): React.JSX.Element {
  const { input, metadata, status, hideDetails, t = defaultTranslate } = props

  const filePath = input.filePath !== undefined ? String(input.filePath) : undefined
  const filename = filePath ? getFilename(filePath) : undefined

  const filediff = toFileDiff(metadata?.filediff)

  const additions = filediff.additions ?? filediff.additionLines ?? 0
  const deletions = filediff.deletions ?? filediff.deletionLines ?? 0

  const diffAction = <DiffChanges additions={additions} deletions={deletions} />

  let diffContent: React.JSX.Element | null = null

  if (filediff.patch) {
    diffContent = <UnifiedDiff patch={filediff.patch} />
  } else if (filediff.before !== undefined || filediff.after !== undefined) {
    diffContent = <BeforeAfterDiff before={filediff.before ?? ''} after={filediff.after ?? ''} />
  } else if (input.oldString !== undefined || input.newString !== undefined) {
    diffContent = (
      <BeforeAfterDiff
        before={input.oldString !== undefined ? String(input.oldString) : ''}
        after={input.newString !== undefined ? String(input.newString) : ''}
      />
    )
  }

  return (
    <BasicTool
      icon={FileCode}
      trigger={{ title: t('devStudio.opencode.tool.edit'), subtitle: filename, action: diffAction }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:edit'
    >
      {diffContent}
    </BasicTool>
  )
}

/**
 * Renderer for the `write` tool.
 * Header: Write + filename.
 * Expandable: file content in a mono pre block.
 */
export function writeTool(props: ToolProps): React.JSX.Element {
  const { input, status, hideDetails, t = defaultTranslate } = props

  const filePath = input.filePath !== undefined ? String(input.filePath) : undefined
  const filename = filePath ? getFilename(filePath) : undefined
  const content = input.content !== undefined ? String(input.content) : ''

  return (
    <BasicTool
      icon={FileCode}
      trigger={{ title: t('devStudio.opencode.tool.write'), subtitle: filename }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:write'
    >
      <pre className='overflow-x-auto text-xs font-mono whitespace-pre'>{content}</pre>
    </BasicTool>
  )
}
