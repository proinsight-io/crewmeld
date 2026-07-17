'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import type { OpencodeRetryStatus } from '../hooks/use-opencode-stream'

interface Props {
  /** Live retry status from `session.status: retry`. */
  retry: OpencodeRetryStatus
}

/**
 * Inline banner shown while opencode is retrying the current turn server-side
 * (transient provider failures: overloaded / 5xx / rate-limit with retry-after).
 * Mirrors opencode's own `session-retry.tsx`: a warning-tinted card with a
 * spinner, the provider message, attempt number, and a live countdown to the
 * next attempt — so the operator sees "recovering" instead of a frozen UI.
 *
 * Distinct from the plain "working" indicator (a normal in-flight turn) and from
 * the destructive error box (a terminal failure).
 */
export function OpencodeRetryBanner({ retry }: Props) {
  const { t } = useTranslation()
  // Seconds remaining until the next attempt, recomputed every second. `next` is
  // epoch ms; clamp at 0 so a passed deadline shows "0s" rather than negatives.
  const [seconds, setSeconds] = useState(() => remaining(retry.next))

  useEffect(() => {
    setSeconds(remaining(retry.next))
    const id = setInterval(() => setSeconds(remaining(retry.next)), 1000)
    return () => clearInterval(id)
  }, [retry.next])

  return (
    <div
      className='my-1 flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400'
      data-testid='dev-studio:opencode-retry'
    >
      <div className='flex items-center gap-2'>
        <span className='flex gap-1'>
          <span className='size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]' />
          <span className='size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]' />
          <span className='size-1.5 rounded-full bg-current animate-bounce' />
        </span>
        <span className='font-medium'>{t('devStudio.opencode.status.retrying')}</span>
        {retry.attempt > 0 && (
          <span className='text-xs opacity-80'>
            {t('devStudio.opencode.status.retryAttempt', { attempt: retry.attempt })}
          </span>
        )}
        {seconds > 0 && (
          <span className='text-xs opacity-80'>
            · {t('devStudio.opencode.status.retryCountdown', { seconds })}
          </span>
        )}
      </div>
      {retry.message && <span className='text-xs opacity-70'>{retry.message}</span>}
    </div>
  )
}

/** Whole seconds until `nextEpochMs`, clamped to >= 0. */
function remaining(nextEpochMs: number): number {
  if (!nextEpochMs) return 0
  return Math.max(0, Math.ceil((nextEpochMs - Date.now()) / 1000))
}
