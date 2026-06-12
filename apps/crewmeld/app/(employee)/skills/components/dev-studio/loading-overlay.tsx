'use client'

import { Loader2 } from 'lucide-react'

interface LoadingOverlayProps {
  /** Label rendered below the spinner. */
  label: string
  /** Optional test id for E2E assertions. */
  testId?: string
}

/**
 * Frosted, full-area loading overlay. Rendered over the dialog body during
 * async transitions that recreate the container or otherwise leave the view
 * unchanged for several seconds (model switch, fork, new session) so the
 * operator gets visible feedback instead of a frozen screen.
 */
export function LoadingOverlay({ label, testId }: LoadingOverlayProps) {
  return (
    <div
      className='absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-[1px] text-sm text-muted-foreground'
      data-testid={testId ?? 'dev-studio:loading-overlay'}
    >
      <Loader2 className='size-8 animate-spin' />
      <span>{label}</span>
    </div>
  )
}
