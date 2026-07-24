'use client'

import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'
import type { AdoptProgressState } from './hooks/use-adopt-progress'

interface AdoptProgressDialogProps {
  state: AdoptProgressState
  onRetry: () => void
  onClose: () => void
}

export function AdoptProgressDialog({ state, onRetry, onClose }: AdoptProgressDialogProps) {
  const { t } = useTranslation()
  const processing = state.kind === 'processing'

  function progressLabel(): string {
    if (state.kind !== 'processing') return ''
    if (state.step === 'installing-dependencies') {
      return t('devStudio.adopt.progressInstalling', {
        libraries: state.libraries.join('、'),
      })
    }
    const keys = {
      syncing: 'devStudio.adopt.progressSyncing',
      saving: 'devStudio.adopt.progressSaving',
      closing: 'devStudio.adopt.progressClosing',
    } as const
    return t(keys[state.step])
  }

  return (
    <Dialog
      open={state.kind !== 'idle'}
      onOpenChange={(open) => {
        if (!open && state.kind === 'failed') onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid='dev-studio:adopt-progress-dialog'
        onEscapeKeyDown={(event) => {
          if (processing) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (processing) event.preventDefault()
        }}
      >
        <DialogTitle>{t('devStudio.adopt.progressTitle')}</DialogTitle>
        <DialogDescription>{t('devStudio.adopt.progressBody')}</DialogDescription>
        {state.kind === 'processing' && (
          <div className='flex items-center gap-2 py-4 text-sm' aria-live='polite'>
            <Loader2
              className='size-5 shrink-0 animate-spin'
              data-testid='dev-studio:adopt-progress:spinner'
            />
            <span>{progressLabel()}</span>
          </div>
        )}
        {state.kind === 'failed' && (
          <>
            <div className='py-4 text-destructive text-sm' role='alert'>
              {state.message}
            </div>
            <DialogFooter>
              <Button type='button' variant='outline' onClick={onClose}>
                {t('devStudio.adopt.progressClose')}
              </Button>
              {state.retryable && (
                <Button type='button' onClick={onRetry}>
                  {t('devStudio.adopt.progressRetry')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
