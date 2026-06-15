'use client'

import { HelpCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { NotificationCardShell } from './notification-card-shell'
import type { AskNotification, ConfirmAskPayload } from './types'

interface Props {
  notification: AskNotification
  onOpen: () => void
  onDismiss: () => void
}

/**
 * Notification card for `<ask type="confirm">` HITL prompts.
 *
 * Notify-only — see {@link AskChoiceCard} for why answering happens in the
 * workbench, not here.
 */
export function AskConfirmCard({ notification, onOpen, onDismiss }: Props) {
  const { t } = useTranslation()
  const payload = notification.payload as ConfirmAskPayload

  return (
    <NotificationCardShell
      sessionTitle={notification.sessionTitle}
      streaming={notification.streaming}
      onOpen={onOpen}
      onDismiss={onDismiss}
      openLabel={t('devStudio.notificationCard.answerButton')}
      icon={<HelpCircle className='size-3.5 shrink-0 text-primary' />}
      title={t('devStudio.ask.confirmTitle')}
    >
      <p className='text-sm text-foreground'>{payload.question}</p>
    </NotificationCardShell>
  )
}
