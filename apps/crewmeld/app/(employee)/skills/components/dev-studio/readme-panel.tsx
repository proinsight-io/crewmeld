'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'
import { useReadme } from './hooks/use-readme'
import { ReadmeEditor } from './readme-editor'
import { ReadmeViewer } from './readme-viewer'

interface ReadmePanelProps {
  sessionId: string
}

/**
 * README tab container.
 *
 * Owns the viewer/editor mode toggle and routes the SWR-backed readme value
 * down to {@link ReadmeViewer} / {@link ReadmeEditor}. When the workspace has
 * no README yet (404 → `readme === null`) we render an empty state with a
 * single "Start editing" call-to-action so the operator can hand-write one before
 * the AI ever produces one. After a successful save we revalidate the SWR
 * cache and flip back to viewer mode.
 */
export function ReadmePanel({ sessionId }: ReadmePanelProps) {
  const { t } = useTranslation()
  const { readme, mutate } = useReadme(sessionId)
  const [editing, setEditing] = useState(false)

  if (readme === null && !editing) {
    return (
      <div
        className='flex h-full flex-col items-center justify-center gap-4 p-8 text-center text-muted-foreground text-sm'
        data-testid='dev-studio:readme-panel:empty'
      >
        <p>{t('devStudio.readme.empty')}</p>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => setEditing(true)}
          data-testid='dev-studio:readme-panel:start-edit'
        >
          {t('devStudio.readme.startEdit')}
        </Button>
      </div>
    )
  }

  return (
    <div className='flex h-full flex-col' data-testid='dev-studio:readme-panel'>
      <div className='flex shrink-0 items-center justify-end border-b p-2'>
        {editing ? (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => setEditing(false)}
            data-testid='dev-studio:readme-panel:view'
          >
            {t('devStudio.readme.view')}
          </Button>
        ) : (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => setEditing(true)}
            data-testid='dev-studio:readme-panel:edit'
          >
            {t('devStudio.readme.edit')}
          </Button>
        )}
      </div>
      {editing ? (
        <ReadmeEditor
          sessionId={sessionId}
          initial={readme ?? ''}
          onSaved={() => {
            void mutate()
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <ReadmeViewer markdown={readme ?? ''} />
      )}
    </div>
  )
}
