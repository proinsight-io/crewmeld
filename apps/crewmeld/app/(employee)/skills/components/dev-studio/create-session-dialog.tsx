'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
  /** Confirm with the chosen model_configs id. */
  onConfirm: (modelConfigId: string | null) => void
  onCancel: () => void
}

/** Shape of one coding model config returned by GET /models?category=coding. */
interface CodingModelConfig {
  id: string
}

/**
 * Model-pick dialog shown when starting a NEW dev session (entry flow + the
 * SessionSwitcher "+ new session" action). Lets the operator pick the coding
 * model the sandbox will run with before the container is created.
 *
 * On open it loads the active coding models and pre-selects a random one (there
 * is no longer a global-env "system default" — the .env ANTHROPIC_* fallback is
 * deprecated). When none are enabled it shows an empty state pointing at the
 * Connections page instead of letting the operator create a session that would
 * fail at sandbox time.
 */
export function CreateSessionDialog({ open, onConfirm, onCancel }: CreateSessionDialogProps) {
  const { t } = useTranslation()
  const [modelConfigId, setModelConfigId] = useState<string | null>(null)
  // null = still loading; [] = loaded but no active coding models.
  const [configs, setConfigs] = useState<CodingModelConfig[] | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setConfigs(null)
    setModelConfigId(null)
    fetch('/api/employee/models?category=coding&activeOnly=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return
        const list = (json?.data?.configs ?? []) as CodingModelConfig[]
        setConfigs(list)
        if (list.length > 0) {
          // Pre-select a random enabled coding model as the default.
          const pick = list[Math.floor(Math.random() * list.length)]
          setModelConfigId(pick.id)
        }
      })
      .catch(() => {
        if (!cancelled) setConfigs([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const isLoading = configs === null
  const isEmpty = configs !== null && configs.length === 0

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

        {isLoading ? (
          <div className='flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm'>
            <Loader2 className='size-4 animate-spin' />
            {t('devStudio.createSession.loading')}
          </div>
        ) : isEmpty ? (
          <div
            className='flex flex-col items-center gap-3 py-6 text-center'
            data-testid='dev-studio:create-session-dialog:empty'
          >
            <p className='text-muted-foreground text-sm'>
              {t('devStudio.createSession.noCodingModel')}
            </p>
            <Button asChild data-testid='dev-studio:create-session-dialog:configure'>
              <a href='/connections'>{t('devStudio.createSession.goConfigure')}</a>
            </Button>
          </div>
        ) : (
          <div className='py-2'>
            <ModelSelector value={modelConfigId} onChange={setModelConfigId} />
          </div>
        )}

        <DialogFooter>
          <Button
            variant='outline'
            onClick={onCancel}
            data-testid='dev-studio:create-session-dialog:cancel'
          >
            {t('devStudio.createSession.cancel')}
          </Button>
          {!isEmpty && (
            <Button
              onClick={() => onConfirm(modelConfigId)}
              disabled={isLoading || !modelConfigId}
              data-testid='dev-studio:create-session-dialog:confirm'
            >
              {t('devStudio.createSession.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
