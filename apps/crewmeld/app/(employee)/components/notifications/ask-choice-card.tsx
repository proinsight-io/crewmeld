'use client'

import { HelpCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { NotificationCardShell } from './notification-card-shell'
import type { AskNotification, ChoiceAskPayload } from './types'

interface Props {
  notification: AskNotification
  onOpen: () => void
  onDismiss: () => void
}

/**
 * Notification card for `<ask type="choice">` HITL prompts.
 *
 * Notify-only: shows the question and routes the operator into the workbench
 * to answer (where the inline card has full conversation context and a live
 * container). Answering is intentionally NOT offered here — answering a
 * backgrounded session's ask would have to resume that session and, under the
 * one-running-container limit, steal the container from the active session.
 */
export function AskChoiceCard({ notification, onOpen, onDismiss }: Props) {
  const { t } = useTranslation()
  const payload = notification.payload as ChoiceAskPayload

  return (
    <NotificationCardShell
      sessionTitle={notification.sessionTitle}
      streaming={notification.streaming}
      onOpen={onOpen}
      onDismiss={onDismiss}
      openLabel={t('devStudio.notificationCard.answerButton')}
      icon={<HelpCircle className='size-3.5 shrink-0 text-primary' />}
      title={t('devStudio.ask.notificationTitle')}
    >
      <p className='text-sm text-foreground'>{payload.question}</p>
    </NotificationCardShell>
  )
}
