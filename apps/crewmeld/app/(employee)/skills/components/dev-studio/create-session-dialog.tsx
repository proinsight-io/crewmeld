'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'
import { ModelSelector } from './model-selector'

interface CreateSessionDialogProps {
  open: boolean
  /** Confirm with the chosen model_configs id, or null for "system default". */
  onConfirm: (modelConfigId: string | null) => void
  onCancel: () => void
}

/**
 * Small confirm dialog shown when the operator starts a NEW dev session via the
 * SessionSwitcher "+ new session" action. Lets them pick the coding model the
 * sandbox will run with before the container is created (Sub-spec C §5.3).
 * Defaults to "system default" (global env), so confirming without touching the
 * selector keeps the prior behavior.
 */
export function CreateSessionDialog({ open, onConfirm, onCancel }: CreateSessionDialogProps) {
  const { t } = useTranslation()
  const [modelConfigId, setModelConfigId] = useState<string | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <DialogContent data-testid='dev-studio:create-session-dialog'>
        <DialogHeader>
          <DialogTitle>{t('devStudio.createSession.title')}</DialogTitle>
          <DialogDescription>{t('devStudio.createSession.modelLabel')}</DialogDescription>
        </DialogHeader>
        <div className='py-2'>
          <ModelSelector value={modelConfigId} onChange={setModelConfigId} />
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={onCancel}
            data-testid='dev-studio:create-session-dialog:cancel'
          >
            {t('devStudio.createSession.cancel')}
          </Button>
          <Button
            onClick={() => onConfirm(modelConfigId)}
            data-testid='dev-studio:create-session-dialog:confirm'
          >
            {t('devStudio.createSession.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
