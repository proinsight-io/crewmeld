'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

interface ResumeOverlayProps {
  /** Session whose container needs rehydration. */
  sessionId: string
  /** Callback invoked after a successful rehydrate POST. */
  onResumed: () => void
}

/**
 * Frosted overlay rendered over the chat input area when the session's
 * container is not running. The single "Resume" button calls the
 * `/rehydrate` endpoint which either probes the live container or spins
 * a fresh one bound to the same host directories.
 */
export function ResumeOverlay({ sessionId, onResumed }: ResumeOverlayProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleResume() {
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

  return (
    <div
      className='absolute inset-0 bg-muted/60 backdrop-blur-[1px] flex flex-col items-center justify-center gap-3 z-10 rounded-b-lg'
      data-testid='dev-studio:resume-overlay'
    >
      <Button
        onClick={handleResume}
        disabled={loading}
        size='lg'
        data-testid='dev-studio:resume-overlay:button'
      >
        {loading ? (
          <>
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            {t('devStudio.session.resuming')}
          </>
        ) : (
          t('devStudio.session.resume')
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
