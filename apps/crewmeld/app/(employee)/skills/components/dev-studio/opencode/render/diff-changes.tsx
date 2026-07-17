'use client'

import type React from 'react'

/**
 * DiffChanges — renders `+N` (green) and `-N` (red) diff statistics.
 * Returns null when both additions and deletions are zero.
 */
export function DiffChanges({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}): React.JSX.Element | null {
  if (additions === 0 && deletions === 0) return null

  return (
    <span className='inline-flex items-center gap-1 font-mono text-xs'>
      {additions > 0 && (
        <span className='text-green-600 dark:text-green-400' data-testid='diff-changes:additions'>
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span className='text-red-600 dark:text-red-400' data-testid='diff-changes:deletions'>
          -{deletions}
        </span>
      )}
    </span>
  )
}
