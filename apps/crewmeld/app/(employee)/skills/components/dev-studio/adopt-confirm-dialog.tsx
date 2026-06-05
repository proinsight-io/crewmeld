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

interface AdoptConfirmDialogProps {
  open: boolean
  sessionId: string
  /**
   * Called both when the operator cancels and after a successful adopt. The
   * caller is responsible for any further chrome teardown (e.g. closing the
   * outer dev-studio dialog) — keeping the responsibility split here avoids
   * coupling this dialog to the parent's lifecycle.
   */
  onClose: () => void
  /**
   * Optional callback invoked once after a successful adopt PATCH. Used by
   * the dev-studio dialog to also tear down the outer dialog (the workspace
   * is gone — the container has been destroyed by the BFF — so leaving the
   * dialog open would just show a stale shell). Fires *before* `onClose`
   * so parents can pivot away from the now-archived session id without a
   * brief flash of empty content.
   */
  onSuccess?: () => void
}

/**
 * Confirmation prompt before the destructive Adopt action.
 *
 * Patches `/api/employee/dev-studio/sessions/:id/adopt`. The endpoint is
 * responsible for destroying the sandbox container and flipping the session
 * to its archived state; we just gate the call behind a confirm + render any
 * BFF error inline so the operator can retry from the same dialog.
 */
export function AdoptConfirmDialog({
  open,
  sessionId,
  onClose,
  onSuccess,
}: AdoptConfirmDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConfirm() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/adopt`,
        { method: 'PATCH' }
      )
      if (!res.ok) {
        throw new Error(t('devStudio.adopt.failed', { status: res.status }))
      }
      // onSuccess first so the dev-studio dialog disappears before we close
      // this confirm — otherwise the operator briefly sees the empty
      // workspace shell behind the dialog.
      onSuccess?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent data-testid='dev-studio:adopt-dialog'>
        <DialogTitle>{t('devStudio.adopt.confirmTitle')}</DialogTitle>
        <DialogDescription>{t('devStudio.adopt.confirmBody')}</DialogDescription>
        {error && (
          <div className='text-destructive text-sm' data-testid='dev-studio:adopt-dialog:error'>
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={onClose}
            disabled={busy}
            data-testid='dev-studio:adopt-dialog:cancel'
          >
            {t('devStudio.adopt.confirmCancel')}
          </Button>
          <Button
            type='button'
            onClick={onConfirm}
            disabled={busy}
            data-testid='dev-studio:adopt-dialog:confirm'
          >
            {busy ? t('devStudio.adopt.processing') : t('devStudio.adopt.confirmOk')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
