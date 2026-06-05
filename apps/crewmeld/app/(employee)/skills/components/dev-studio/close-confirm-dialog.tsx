'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'

/**
 * The action chosen by the operator in the close-confirm dialog.
 *
 * - `adopt` (post-pack only): mark the tool as completed and destroy the
 *   sandbox container.
 * - `background`: keep the container running so work resumes next time.
 * - `discard` (post-pack only): archive as abandoned and destroy the container.
 * - `terminate` (pre-pack only): interrupt the in-progress task and destroy
 *   the container.
 * - `cancel`: never returned via `onConfirm` — surfaced through `onCancel`
 *   instead, but listed here for exhaustive type checks downstream.
 */
export type CloseAction =
  | { kind: 'adopt' }
  | { kind: 'background' }
  | { kind: 'discard' }
  | { kind: 'terminate' }
  | { kind: 'cancel' }

interface CloseConfirmDialogProps {
  open: boolean
  /**
   * Whether the workspace has already produced a manifest. Drives the entire
   * button set per the spec §3 decision table (post-pack vs pre-pack).
   */
  manifestPresent: boolean
  /** Called with the chosen non-cancel action. */
  onConfirm: (action: CloseAction) => void
  /** Called when the operator dismisses the dialog (cancel button or overlay). */
  onCancel: () => void
}

/**
 * Confirmation prompt that gates closing or switching away from a dev-studio
 * session.
 *
 * The button set diverges sharply between the two states. Post-pack the
 * operator gets the "Adopt / Keep in background / Discard" trichotomy; pre-pack we only
 * offer "Keep in background / Terminate task" because there is nothing yet to adopt or
 * discard as a deliverable. This component is presentation-only: it
 * surfaces the operator's choice via `onConfirm` and leaves the actual
 * adopt/discard/terminate API calls to the caller.
 */
export function CloseConfirmDialog({
  open,
  manifestPresent,
  onConfirm,
  onCancel,
}: CloseConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel()
      }}
    >
      <DialogContent data-testid='dev-studio:close-dialog'>
        <DialogTitle>
          {manifestPresent
            ? t('devStudio.closeConfirm.postPackTitle')
            : t('devStudio.closeConfirm.prePackTitle')}
        </DialogTitle>
        <DialogDescription>
          {manifestPresent
            ? t('devStudio.closeConfirm.postPackBody')
            : t('devStudio.closeConfirm.prePackBody')}
        </DialogDescription>
        {manifestPresent ? (
          <div className='mt-4 flex flex-col gap-2'>
            <Button
              type='button'
              onClick={() => onConfirm({ kind: 'adopt' })}
              className='justify-start'
              data-testid='dev-studio:close-dialog:adopt'
            >
              <span>{t('devStudio.closeConfirm.adopt')}</span>
              <span className='ml-auto text-primary-foreground/70 text-xs'>
                {t('devStudio.closeConfirm.adoptHint')}
              </span>
            </Button>
            <Button
              type='button'
              variant='outline'
              onClick={() => onConfirm({ kind: 'background' })}
              className='justify-start'
              data-testid='dev-studio:close-dialog:background'
            >
              <span>{t('devStudio.closeConfirm.background')}</span>
              <span className='ml-auto text-muted-foreground text-xs'>
                {t('devStudio.closeConfirm.backgroundHint')}
              </span>
            </Button>
            <Button
              type='button'
              variant='destructive'
              onClick={() => onConfirm({ kind: 'discard' })}
              className='justify-start'
              data-testid='dev-studio:close-dialog:discard'
            >
              <span>{t('devStudio.closeConfirm.discard')}</span>
              <span className='ml-auto text-destructive-foreground/70 text-xs'>
                {t('devStudio.closeConfirm.discardHint')}
              </span>
            </Button>
          </div>
        ) : (
          <div className='mt-4 flex flex-col gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onConfirm({ kind: 'background' })}
              className='justify-start'
              data-testid='dev-studio:close-dialog:background'
            >
              <span>{t('devStudio.closeConfirm.background')}</span>
              <span className='ml-auto text-muted-foreground text-xs'>
                {t('devStudio.closeConfirm.backgroundHint')}
              </span>
            </Button>
            <Button
              type='button'
              variant='destructive'
              onClick={() => onConfirm({ kind: 'terminate' })}
              className='justify-start'
              data-testid='dev-studio:close-dialog:terminate'
            >
              <span>{t('devStudio.closeConfirm.terminate')}</span>
              <span className='ml-auto text-destructive-foreground/70 text-xs'>
                {t('devStudio.closeConfirm.terminateHint')}
              </span>
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button
            type='button'
            variant='ghost'
            onClick={onCancel}
            data-testid='dev-studio:close-dialog:cancel'
          >
            {t('devStudio.closeConfirm.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
