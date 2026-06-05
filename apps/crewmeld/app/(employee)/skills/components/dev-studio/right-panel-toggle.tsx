'use client'

import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Tooltip } from '@/components/emcn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'
import { useSessionList } from './hooks/use-session-list'

interface RightPanelToggleProps {
  /** Currently active session id. The button is disabled when `null`. */
  sessionId: string | null
  /** Current value of `session.rightPanelVisible` from the server row. */
  visible: boolean
}

/**
 * Icon button that toggles the workspace right-panel for the active session.
 *
 * Persists the new value via PATCH so the layout survives reloads + cross-tab
 * sessions, then invalidates the session list so the dialog body re-renders
 * the split layout (or collapses back to single-column) on the next paint.
 */
export function RightPanelToggle({ sessionId, visible }: RightPanelToggleProps) {
  const { t } = useTranslation()
  const { mutate } = useSessionList()

  async function onToggle() {
    if (!sessionId) return
    await fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rightPanelVisible: !visible }),
    })
    await mutate()
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button
          size='icon'
          variant='ghost'
          type='button'
          onClick={onToggle}
          disabled={!sessionId}
          aria-label={
            visible ? t('devStudio.header.collapseRight') : t('devStudio.header.expandRight')
          }
          data-testid='dev-studio:right-panel-toggle'
        >
          {visible ? <PanelRightClose className='size-4' /> : <PanelRightOpen className='size-4' />}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {visible ? t('devStudio.header.collapseRight') : t('devStudio.header.expandRight')}
      </Tooltip.Content>
    </Tooltip.Root>
  )
}
