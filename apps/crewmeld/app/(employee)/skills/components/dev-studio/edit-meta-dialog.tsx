'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import { useTranslation } from '@/hooks/use-translation'
import { useManifest } from './hooks/use-manifest'

interface EditMetaDialogProps {
  open: boolean
  sessionId: string
  manifest: ManifestT
  onClose: () => void
}

/**
 * Operator-editable manifest fields (name + description).
 *
 * Saves via `PATCH /api/employee/dev-studio/sessions/:id/manifest`. The
 * version number is intentionally not editable here — it is bumped by the
 * AI when it rewrites the entrypoint or contract shape. Re-opening the
 * dialog resets the local form to the latest manifest so a previous typo
 * never resurrects on the next open.
 */
export function EditMetaDialog({ open, sessionId, manifest, onClose }: EditMetaDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(manifest.name)
  const [description, setDescription] = useState(manifest.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { mutate } = useManifest(sessionId)

  // Reset the form whenever the dialog transitions to open so stale edits
  // from a previously-cancelled session can never bleed into a new edit.
  useEffect(() => {
    if (open) {
      setName(manifest.name)
      setDescription(manifest.description ?? '')
      setError(null)
    }
  }, [open, manifest.name, manifest.description])

  async function onSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/manifest`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        }
      )
      if (!res.ok) {
        throw new Error(t('devStudio.toolMeta.saveFailed', { status: res.status }))
      }
      await mutate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent data-testid='dev-studio:edit-meta-dialog'>
        <DialogTitle>{t('devStudio.toolMeta.edit')}</DialogTitle>
        <DialogDescription>{t('devStudio.toolMeta.editDescription')}</DialogDescription>
        <div className='space-y-3'>
          <div className='space-y-1'>
            <label htmlFor='dev-studio-meta-name' className='text-sm'>
              {t('devStudio.toolMeta.nameLabel')}
            </label>
            <Input
              id='dev-studio-meta-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              data-testid='dev-studio:edit-meta-dialog:name'
            />
          </div>
          <div className='space-y-1'>
            <label htmlFor='dev-studio-meta-desc' className='text-sm'>
              {t('devStudio.toolMeta.descriptionLabel')}
            </label>
            <Textarea
              id='dev-studio-meta-desc'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={4}
              data-testid='dev-studio:edit-meta-dialog:description'
            />
          </div>
          {error && (
            <div
              className='text-xs text-destructive'
              data-testid='dev-studio:edit-meta-dialog:error'
            >
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            type='button'
            onClick={onClose}
            disabled={saving}
            data-testid='dev-studio:edit-meta-dialog:cancel'
          >
            {t('devStudio.toolMeta.cancel')}
          </Button>
          <Button
            type='button'
            onClick={onSave}
            disabled={saving || !name.trim()}
            data-testid='dev-studio:edit-meta-dialog:save'
          >
            {saving ? t('devStudio.toolMeta.saving') : t('devStudio.toolMeta.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
