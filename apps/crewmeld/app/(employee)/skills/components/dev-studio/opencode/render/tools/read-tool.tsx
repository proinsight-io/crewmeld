'use client'

import type React from 'react'
import { CornerDownRight, Glasses } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { defaultTranslate, getFilename } from '../tool-info'
import type { ToolProps } from './registry'

/** Narrows an unknown value to a string array. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/**
 * Renderer for the `read` tool.
 * Header: Read + filename + optional offset/limit args.
 * Below the card: list of metadata.loaded file paths.
 */
export function readTool(props: ToolProps): React.JSX.Element {
  const { input, metadata, status, hideDetails, t = defaultTranslate } = props

  const filePath = input.filePath !== undefined ? String(input.filePath) : undefined
  const filename = filePath ? getFilename(filePath) : undefined

  const args: string[] = []
  if (input.offset !== undefined) args.push(`offset=${String(input.offset)}`)
  if (input.limit !== undefined) args.push(`limit=${String(input.limit)}`)

  const loaded = toStringArray(metadata?.loaded)

  return (
    <div>
      <BasicTool
        icon={Glasses}
        trigger={{
          title: t('devStudio.opencode.tool.read'),
          subtitle: filename,
          args: args.length > 0 ? args : undefined,
        }}
        status={status}
        hideDetails={hideDetails}
        data-testid='opencode-message:tool:read'
      />
      {loaded.length > 0 && (
        <ul className='mt-1 space-y-0.5'>
          {loaded.map((path) => (
            <li key={path} className='flex items-center gap-1 text-xs text-muted-foreground'>
              <CornerDownRight className='h-3 w-3 shrink-0' />
              <span>{t('devStudio.opencode.tool.loaded', { path })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
