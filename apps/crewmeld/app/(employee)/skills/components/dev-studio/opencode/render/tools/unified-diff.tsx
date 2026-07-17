'use client'

import type React from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { cn } from '@/lib/core/utils/cn'

/** A single line in a unified diff with its type classification. */
interface DiffLine {
  text: string
  type: 'added' | 'removed' | 'header' | 'context'
}

/** Classifies a raw patch line by its first character. */
function classifyLine(line: string): DiffLine['type'] {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added'
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed'
  if (line.startsWith('@@')) return 'header'
  return 'context'
}

/** Renders a unified diff patch string as colored lines. */
export function UnifiedDiff({ patch }: { patch: string }): React.JSX.Element {
  const lines: DiffLine[] = patch.split('\n').map((text) => ({
    text,
    type: classifyLine(text),
  }))

  return (
    <pre className='overflow-x-auto text-xs font-mono leading-5'>
      {lines.map((line, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          data-testid={
            line.type === 'added'
              ? 'unified-diff:line:added'
              : line.type === 'removed'
                ? 'unified-diff:line:removed'
                : line.type === 'header'
                  ? 'unified-diff:line:header'
                  : 'unified-diff:line:context'
          }
          className={cn(
            'px-2',
            line.type === 'added' &&
              'bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300',
            line.type === 'removed' &&
              'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300',
            line.type === 'header' && 'text-muted-foreground'
          )}
        >
          {line.text}
        </div>
      ))}
    </pre>
  )
}

/** Simple before/after view for tools that expose old/new string directly. */
export function BeforeAfterDiff({
  before,
  after,
}: {
  before: string
  after: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className='space-y-1 text-xs font-mono'>
      {before && (
        <div className='rounded bg-red-50 p-2 text-red-800 dark:bg-red-950/40 dark:text-red-300'>
          <div className='mb-1 font-semibold text-[10px] text-muted-foreground'>
            {t('devStudio.opencode.diff.removed')}
          </div>
          <pre className='whitespace-pre-wrap'>{before}</pre>
        </div>
      )}
      {after && (
        <div className='rounded bg-green-50 p-2 text-green-800 dark:bg-green-950/40 dark:text-green-300'>
          <div className='mb-1 font-semibold text-[10px] text-muted-foreground'>
            {t('devStudio.opencode.diff.added')}
          </div>
          <pre className='whitespace-pre-wrap'>{after}</pre>
        </div>
      )}
    </div>
  )
}
