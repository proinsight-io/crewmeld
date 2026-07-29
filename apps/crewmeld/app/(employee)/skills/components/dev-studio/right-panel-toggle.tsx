'use client'

import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { mutate as globalMutate } from 'swr'
import { Tooltip } from '@/components/emcn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

interface RightPanelToggleProps {
  /** Currently active session id. The button is disabled when `null`. */
  sessionId: string | null
  /** Current value of `session.rightPanelVisible` from the server row. */
  visible: boolean
  /** Lets the owning dialog update its layout immediately after persistence. */
  onVisibleChange?: (visible: boolean) => void
}

/**
 * Icon button that toggles the workspace right-panel for the active session.
 *
 * Persists the new value via PATCH so the layout survives reloads + cross-tab
 * sessions, then invalidates the session list so the dialog body re-renders
 * the split layout (or collapses back to single-column) on the next paint.
 */
export function RightPanelToggle({ sessionId, visible, onVisibleChange }: RightPanelToggleProps) {
  const { t } = useTranslation()

  async function onToggle() {
    if (!sessionId) return
    const nextVisible = !visible
    const res = await fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rightPanelVisible: nextVisible }),
    })
    if (!res.ok) return
    onVisibleChange?.(nextVisible)
    // The dialog may be scoped to a tool (`?toolId=...&status=all`) while this
    // control previously refreshed only the generic list. Revalidate every
    // sessions-list cache so the SplitPane sees the persisted change at once.
    await globalMutate((key) => typeof key === 'string' && key.startsWith('/api/employee/dev-studio/sessions'))
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
