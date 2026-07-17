'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'
import type { ReviewLibrary } from './dependency-review-card'

interface DependencyGateDialogProps {
  open: boolean
  sessionId: string
  /** Pending (non-global, unapproved) libraries needing approval. */
  libraries: ReviewLibrary[]
  /** Declared domains (read-only, shown for context). */
  domains: string[]
  /** Called after a successful auto-approve; caller proceeds to the adopt-confirm dialog. */
  onApproved: () => void
  onCancel: () => void
}

/**
 * Interstitial shown when the operator clicks Adopt on a session that still
 * has AI-declared library/domain dependencies pending approval. Rather than
 * hard-blocking adopt (forcing a trip to the inline chat review card), this
 * offers a one-click auto-approve: confirming POSTs the same
 * `/dependencies/approve` snapshot the chat card would, then hands control
 * back to the caller to open the normal {@link AdoptConfirmDialog}.
 */
export function DependencyGateDialog({
  open,
  sessionId,
  libraries,
  domains,
  onApproved,
  onCancel,
}: DependencyGateDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConfirm() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies/approve`,
        { method: 'POST' }
      )
      if (!res.ok) {
        setError(t('devStudio.dependencyGate.failed'))
        return
      }
      onApproved()
    } catch {
      setError(t('devStudio.dependencyGate.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onCancel()
      }}
    >
      <DialogContent data-testid='dev-studio:dependency-gate-dialog'>
        <DialogTitle>{t('devStudio.dependencyGate.title')}</DialogTitle>
        <DialogDescription>{t('devStudio.dependencyGate.hint')}</DialogDescription>

        {libraries.length > 0 && (
          <div className='text-xs' data-testid='dev-studio:dependency-gate-dialog:libs'>
            <span className='font-semibold text-muted-foreground'>
              {t('devStudio.dependencyReview.librariesLabel')}:
            </span>{' '}
            <span className='font-mono'>{libraries.map((l) => l.raw).join(', ')}</span>
          </div>
        )}
        {domains.length > 0 && (
          <div className='text-xs' data-testid='dev-studio:dependency-gate-dialog:domains'>
            <span className='font-semibold text-muted-foreground'>
              {t('devStudio.dependencyReview.domainsLabel')}:
            </span>{' '}
            <span className='font-mono'>{domains.join(', ')}</span>
          </div>
        )}

        {error && (
          <div
            className='text-destructive text-sm'
            data-testid='dev-studio:dependency-gate-dialog:error'
          >
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={onCancel}
            disabled={busy}
            data-testid='dev-studio:dependency-gate-dialog:cancel'
          >
            {t('devStudio.dependencyGate.cancel')}
          </Button>
          <Button
            type='button'
            onClick={onConfirm}
            disabled={busy}
            data-testid='dev-studio:dependency-gate-dialog:confirm'
          >
            {busy ? t('devStudio.adopt.processing') : t('devStudio.dependencyGate.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
