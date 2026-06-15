'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/core/utils/cn'
import type { SessionRecord } from '@/lib/dev-studio/session-store'
import { useTranslation } from '@/hooks/use-translation'

interface ConnectionStatusProps {
  /** Session row from the BFF, or `null` when no session is active. */
  session: SessionRecord | null
}

/**
 * Compact sandbox container indicator for the dev-studio header.
 *
 * Translates `session.containerStatus` into one of three visual states:
 *  - `creating` — spinner + "Starting",
 *  - `running`  — green dot + "Running",
 *  - other      — gray dot + "Offline" (covers expired / destroyed / no session).
 */
export function ConnectionStatus({ session }: ConnectionStatusProps) {
  const { t } = useTranslation()
  const status = session?.containerStatus ?? null

  if (status === 'creating') {
    return (
      <span
        className='flex items-center gap-1.5 text-xs text-muted-foreground'
        data-testid='dev-studio:connection-status'
        data-state='creating'
      >
        <Loader2 className='size-3 animate-spin' />
        <span>{t('devStudio.header.containerCreating')}</span>
      </span>
    )
  }

  const running = status === 'running'
  return (
    <span
      className='flex items-center gap-1.5 text-xs text-muted-foreground'
      data-testid='dev-studio:connection-status'
      data-state={running ? 'running' : 'offline'}
    >
      <span
        className={cn(
          'size-2 rounded-full',
          running ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-muted-foreground/50'
        )}
        aria-hidden='true'
      />
      <span>
        {running ? t('devStudio.header.containerRunning') : t('devStudio.header.containerOffline')}
      </span>
    </span>
  )
}
