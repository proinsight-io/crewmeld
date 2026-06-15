'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

/**
 * How the overlay's primary action brings the session back to life:
 *  - `rehydrate`: the session is an in-progress iteration (`status='active'`)
 *    whose container was suspended — POST `/rehydrate` spins a fresh one bound
 *    to the same dirs.
 *  - `fork`: the session is the tool's ADOPTED original. Its container cannot
 *    be rehydrated (the BFF returns 410 Gone for non-active sessions, by
 *    design — the adopted workspace is the published baseline and is frozen).
 *    The only way to continue is to fork a new iteration off it, which the
 *    parent supplies via `onFork`.
 */
export type ResumeMode = 'rehydrate' | 'fork'

interface ResumeOverlayProps {
  /** Session whose container needs rehydration. Only used in `rehydrate` mode. */
  sessionId: string
  /** Selects the primary action — defaults to `rehydrate`. */
  mode?: ResumeMode
  /** Callback invoked after a successful rehydrate POST (`rehydrate` mode). */
  onResumed: () => void
  /**
   * Fork handler (`fork` mode). Should create the iteration and pivot to it;
   * the overlay only owns the in-flight spinner + error surface around it.
   */
  onFork?: () => Promise<void>
}

/**
 * Frosted overlay rendered over the chat input area when the session's
 * container is not running. The single primary button either rehydrates the
 * session's own container (active iteration) or forks a fresh iteration off
 * the adopted baseline — see {@link ResumeMode}.
 */
export function ResumeOverlay({
  sessionId,
  mode = 'rehydrate',
  onResumed,
  onFork,
}: ResumeOverlayProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRehydrate() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/rehydrate`,
        { method: 'POST' }
      )
      if (!res.ok) throw new Error(`Rehydrate failed: ${res.status}`)
      onResumed()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('devStudio.session.resumeFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function handleFork() {
    if (!onFork) return
    setLoading(true)
    setError(null)
    try {
      await onFork()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('devStudio.session.resumeFailed'))
    } finally {
      setLoading(false)
    }
  }

  const isFork = mode === 'fork'
  const idleLabel = isFork
    ? t('devStudio.session.continueFromAdopted')
    : t('devStudio.session.resume')
  const loadingLabel = isFork ? t('devStudio.session.continuing') : t('devStudio.session.resuming')

  return (
    <div
      className='absolute inset-0 bg-muted/60 backdrop-blur-[1px] flex flex-col items-center justify-center gap-3 z-10 rounded-b-lg'
      data-testid='dev-studio:resume-overlay'
    >
      <Button
        onClick={isFork ? handleFork : handleRehydrate}
        disabled={loading}
        size='lg'
        data-testid='dev-studio:resume-overlay:button'
      >
        {loading ? (
          <>
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            {loadingLabel}
          </>
        ) : (
          idleLabel
        )}
      </Button>
      {error && (
        <p className='text-sm text-destructive' data-testid='dev-studio:resume-overlay:error'>
          {error}
        </p>
      )}
    </div>
  )
}
