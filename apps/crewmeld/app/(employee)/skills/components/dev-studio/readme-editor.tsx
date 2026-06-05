'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/use-translation'
import { ReadmeViewer } from './readme-viewer'

interface ReadmeEditorProps {
  sessionId: string
  /** Initial markdown shown in the textarea. */
  initial: string
  /** Invoked after the PUT succeeds — caller is expected to revalidate + flip mode. */
  onSaved: () => void
  /** Invoked when the operator hits Cancel (no fetch is issued). */
  onCancel: () => void
}

/**
 * Markdown editor for the README tab.
 *
 * Two-pane layout: textarea on the left, live `ReadmeViewer` preview on the
 * right. On save we PUT the markdown body to the BFF — a 413 response (>100KB)
 * is surfaced as a friendly cap message; any other non-2xx falls back to a
 * generic "Save failed" error. The component is fully controlled by `initial` +
 * local state and never reads the SWR cache directly; callers wire `onSaved`
 * to revalidate the parent's `useReadme` hook.
 */
export function ReadmeEditor({ sessionId, initial, onSaved, onCancel }: ReadmeEditorProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/readme`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: text }),
        }
      )
      if (!res.ok) {
        if (res.status === 413) setError(t('devStudio.readme.tooLarge'))
        else setError(t('devStudio.readme.saveFailedStatus', { status: res.status }))
        return
      }
      onSaved()
    } catch (e) {
      setError(
        e instanceof Error
          ? t('devStudio.readme.saveFailedMessage', { message: e.message })
          : t('devStudio.readme.saveFailed')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='flex h-full flex-col' data-testid='dev-studio:readme-editor'>
      <div className='grid flex-1 grid-cols-2 gap-0 overflow-hidden'>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className='h-full resize-none rounded-none border-0 font-mono text-sm'
          placeholder={t('devStudio.readme.placeholder')}
          data-testid='dev-studio:readme-editor:textarea'
        />
        <div
          className='h-full overflow-auto border-l'
          data-testid='dev-studio:readme-editor:preview'
        >
          <ReadmeViewer markdown={text} />
        </div>
      </div>
      <div className='flex justify-end gap-2 border-t p-2'>
        {error && (
          <span
            className='self-center text-destructive text-xs'
            data-testid='dev-studio:readme-editor:error'
          >
            {error}
          </span>
        )}
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={onCancel}
          disabled={saving}
          data-testid='dev-studio:readme-editor:cancel'
        >
          {t('devStudio.readme.cancel')}
        </Button>
        <Button
          type='button'
          size='sm'
          onClick={onSave}
          disabled={saving}
          data-testid='dev-studio:readme-editor:save'
        >
          {saving ? t('devStudio.readme.saving') : t('devStudio.readme.save')}
        </Button>
      </div>
    </div>
  )
}
