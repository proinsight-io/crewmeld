'use client'

import type { ReactNode } from 'react'
import { ArrowUpRight, FolderOpen, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Props for {@link NotificationCardShell}.
 *
 * The shell owns the universal layout (header row with title + spinner + jump
 * icon, optional sub-title / hint, body, footer "open" button) so each
 * notification kind only needs to render its inline children.
 */
export interface NotificationCardShellProps {
  /** Title to show on the top-left of the card (usually the session title). */
  sessionTitle: string
  /** Whether the underlying session has an active SSE stream. */
  streaming: boolean
  /**
   * Invoked when the operator wants to pivot to the dev-studio dialog for the
   * session — wired to both the top-right [↗] icon and the footer button so
   * the click target is generous.
   */
  onOpen: () => void
  /** Inline children (form / buttons specific to the notification kind). */
  children: ReactNode
  /** Optional decorative icon rendered before the session title. */
  icon?: ReactNode
  /** Optional secondary headline ("Dependency approval" / "AI question" etc.). */
  title?: string
  /** Optional hint line under the title. */
  hint?: string
  /**
   * Optional dismiss handler. When provided, a small ✕ button is shown in the
   * header so the operator can acknowledge a notification ("I'll deal with it
   * later") without acting on it. Dismissal is the caller's concern (e.g. a
   * local ignore list) — the shell only surfaces the affordance.
   */
  onDismiss?: () => void
  /** Optional label override for the footer button (defaults to "Open"). */
  openLabel?: string
}

/**
 * Shared layout for every notification card in the global NotificationCenter.
 *
 * Renders a compact `<Card>` with three regions:
 *   1. Header row — optional icon + session title + streaming spinner, plus a
 *      top-right [↗] icon button that triggers `onOpen`.
 *   2. Body — optional sub-title / hint, then the inline `children` slot.
 *   3. Footer — full-width "Open" button (also triggers `onOpen`).
 *
 * Pure presentational component — no fetch / mutate / SWR calls live here so
 * cards can drive their own update strategy.
 */
export function NotificationCardShell({
  sessionTitle,
  streaming,
  onOpen,
  children,
  icon,
  title,
  hint,
  onDismiss,
  openLabel,
}: NotificationCardShellProps) {
  const { t } = useTranslation()
  return (
    <Card className='p-3 shadow-md' data-testid='notification-card:shell'>
      <div className='mb-2 flex items-center justify-between'>
        <div className='flex min-w-0 items-center gap-2'>
          {icon}
          <span className='truncate font-medium text-sm text-foreground'>{sessionTitle}</span>
          {streaming && (
            <Loader2
              className='size-3 shrink-0 animate-spin text-muted-foreground'
              data-testid='notification-card:streaming'
            />
          )}
        </div>
        <div className='flex shrink-0 items-center gap-1'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-6 shrink-0'
            onClick={onOpen}
            title={t('devStudio.notificationCard.openTooltip')}
            data-testid='notification-card:goto'
          >
            <ArrowUpRight className='size-3' />
          </Button>
          {onDismiss && (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='size-6 shrink-0'
              onClick={onDismiss}
              title={t('devStudio.notificationCard.dismissTooltip')}
              data-testid='notification-card:dismiss'
            >
              <X className='size-3' />
            </Button>
          )}
        </div>
      </div>
      {title && <div className='mb-1 font-medium text-sm'>{title}</div>}
      {hint && <p className='mb-2 text-muted-foreground text-xs'>{hint}</p>}
      <div className='space-y-2'>{children}</div>
      <Button
        type='button'
        variant='outline'
        size='sm'
        className='mt-3 w-full'
        onClick={onOpen}
        data-testid='notification-card:open'
      >
        <FolderOpen className='mr-1 size-3' />
        {openLabel ?? t('devStudio.notificationCard.openButton')}
      </Button>
    </Card>
  )
}
