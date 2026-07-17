'use client'

import { HelpCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { NotificationCardShell } from './notification-card-shell'
import type { AskNotification, OpencodeQuestionAskPayload } from './types'

interface Props {
  notification: AskNotification
  onOpen: () => void
  onDismiss: () => void
}

/**
 * Notification card for a pending opencode `question.asked` request.
 *
 * Notify-only — mirrors {@link AskChoiceCard}: a backgrounded opencode session
 * that asks a question would otherwise stay silent in the corner. The card
 * shows the first question's summary and routes the operator into the
 * workbench, where the rich multi-question card answers with full context and a
 * live container.
 */
export function OpencodeQuestionCard({ notification, onOpen, onDismiss }: Props) {
  const { t } = useTranslation()
  const payload = notification.payload as OpencodeQuestionAskPayload

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
