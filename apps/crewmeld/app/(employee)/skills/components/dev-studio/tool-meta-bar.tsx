'use client'

import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'
import { EditMetaDialog } from './edit-meta-dialog'
import { useManifest } from './hooks/use-manifest'

interface ToolMetaBarProps {
  /** Currently active session id. Renders nothing when `null`. */
  sessionId: string | null
}

/**
 * Header strip showing the tool name + version pulled from
 * `.crewmeld-studio/manifest.json`, with an edit button that opens
 * {@link EditMetaDialog} for the operator-editable subset.
 *
 * Renders nothing until both a sessionId is selected and a manifest exists —
 * the dev-studio header gracefully collapses in the pre-manifest state
 * (the SessionSwitcher still occupies the leading slot).
 */
export function ToolMetaBar({ sessionId }: ToolMetaBarProps) {
  const { t } = useTranslation()
  const { manifest } = useManifest(sessionId)
  const [editOpen, setEditOpen] = useState(false)

  if (!sessionId || !manifest) return null

  return (
    <div className='flex items-center gap-2' data-testid='dev-studio:tool-meta-bar'>
      <span className='font-medium text-sm'>{manifest.name}</span>
      <Badge variant='outline' className='text-xs'>
        v{manifest.version}
      </Badge>
      <Button
        size='icon'
        variant='ghost'
        type='button'
        onClick={() => setEditOpen(true)}
        className='size-6'
        data-testid='dev-studio:tool-meta-bar:edit'
        aria-label={t('devStudio.header.editMetaAria')}
      >
        <Pencil className='size-3' />
      </Button>
      <EditMetaDialog
        open={editOpen}
        sessionId={sessionId}
        manifest={manifest}
        onClose={() => setEditOpen(false)}
      />
    </div>
  )
}
