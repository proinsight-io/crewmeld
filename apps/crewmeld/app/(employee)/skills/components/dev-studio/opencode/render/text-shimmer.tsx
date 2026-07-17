'use client'

import type React from 'react'

/**
 * TextShimmer — renders a text string with an animated shimmer when active,
 * or as plain text when inactive.
 */
export function TextShimmer({
  text,
  active,
}: {
  text: string
  active: boolean
}): React.JSX.Element {
  if (active) {
    return (
      <span
        className='animate-pulse bg-gradient-to-r from-foreground/60 via-foreground/30 to-foreground/60 bg-clip-text text-transparent'
        aria-label={text}
      >
        {text}
      </span>
    )
  }

  return <span>{text}</span>
}
