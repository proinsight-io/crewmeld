'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, HelpCircle } from 'lucide-react'
import { mutate } from 'swr'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/core/utils/cn'
import type { Ask } from '@/lib/dev-studio/ask-extractor'
import { useTranslation } from '@/hooks/use-translation'
import { useNotifications } from './hooks/use-notifications'

const NOTIFICATIONS_URL = '/api/employee/dev-studio/notifications'

interface Props {
  /** Active session id — required to POST the answer. */
  sessionId: string | null
  /** Parsed ask payload (one of choice / confirm / text). */
  ask: Ask
  /**
   * Invoked after a successful POST so the chat hook can flush a hidden
   * sentinel message that triggers the BFF system-note drain (which
   * injects the answer into the AI's next turn). Without this the user
   * sees their choice land in the DB but the AI keeps waiting.
   */
  onAnswered?: () => void
  /**
   * When true, the card disables all inputs and shows a "answer the newer
   * question instead" hint. Set by the parent chat panel when a later
   * `<ask>` has arrived — the AI no longer expects an answer to this one.
   */
  locked?: boolean
}

/**
 * Inline ask card rendered inside the chat stream.
 *
 * Renders one of three sub-cards driven by `ask.type`:
 *  - choice  → one button per option
 *  - confirm → Yes / No buttons
 *  - text    → textarea + submit
 *
 * Answering POSTs `{ askId, answer }` to `/sessions/<id>/answer-ask` and
 * collapses the card into a read-only "Chose X" line. The answered state
 * lives in component state so the card stays consistent even while the
 * chat list re-renders around it. (Component unmount loses the state —
 * the notification center is the cross-mount source of truth for pending
 * actions, this card is the immediate in-bubble UX.)
 */
export function AskInlineCard({ sessionId, ask, onAnswered, locked = false }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [answered, setAnswered] = useState<{ label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [textValue, setTextValue] = useState('')
  const { asks: pendingAsks } = useNotifications()

  // Cross-surface sync: detect when the same ask was answered elsewhere (the
  // notification-center card, another browser tab) so the inline card folds
  // into a read-only "answered externally" line instead of looking still
  // active. We can't trust `not-in-list` on first render — the SWR fetch
  // may not have returned yet, and pendingAsks would be []. So we wait
  // until we've observed this ask in the list at least once before treating
  // its absence as "answered externally".
  const sawPendingRef = useRef(false)
  const stillPending = pendingAsks.some((a) => a.askId === ask.askId && a.sessionId === sessionId)
  useEffect(() => {
    if (stillPending) sawPendingRef.current = true
  }, [stillPending])
  const externallyAnswered = sawPendingRef.current && !stillPending && answered === null

  // When the ask was answered via the notification center (or another tab),
  // also kick the chat-resume so the AI continues automatically. Without
  // this, the operator answers in the notification center, the inline card
  // collapses to "Answered in notification center", but the AI just sits there — same
  // failure mode as inline-answer-no-resume that we fixed earlier, but
  // routed through the externallyAnswered observer instead of postAnswer.
  const externalResumeFiredRef = useRef(false)
  useEffect(() => {
    if (externallyAnswered && !externalResumeFiredRef.current) {
      externalResumeFiredRef.current = true
      onAnswered?.()
    }
  }, [externallyAnswered, onAnswered])

  async function postAnswer(answer: unknown, summary: string) {
    if (!sessionId || locked) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/answer-ask`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ askId: ask.askId, answer }),
        }
      )
      if (!res.ok) {
        setError(t('devStudio.ask.inlineFailed'))
        return
      }
      setAnswered({ label: summary })
      // Best-effort: refresh the notifications cache so the matching
      // notification-center card (if any) collapses immediately instead of
      // waiting up to 30s for the next SWR poll.
      void mutate(NOTIFICATIONS_URL)
      // Trigger the BFF system-note drain so the AI's next turn arrives
      // automatically (without the operator having to send a new message).
      onAnswered?.()
    } catch {
      setError(t('devStudio.ask.inlineFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (answered || externallyAnswered) {
    if (externallyAnswered) {
      return (
        <div
          className='my-2 mx-2 rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex items-center gap-2'
          data-testid={`ask-inline:answered:${ask.askId}`}
        >
          <Check className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
          <span>{t('devStudio.ask.inlineAnsweredExternal')}</span>
        </div>
      )
    }
    const key =
      ask.type === 'choice'
        ? 'devStudio.ask.inlineAnsweredChoice'
        : ask.type === 'confirm'
          ? 'devStudio.ask.inlineAnsweredConfirm'
          : 'devStudio.ask.inlineAnsweredText'
    return (
      <div
        className='mt-0 mb-2 mx-2 rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex items-center gap-2'
        data-testid={`ask-inline:answered:${ask.askId}`}
      >
        <Check className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
        <span>{t(key, { label: answered?.label ?? '' })}</span>
      </div>
    )
  }

  const inputsDisabled = busy || locked
  return (
    <div
      className={cn(
        // Glue the card to the preceding assistant bubble (no top margin)
        // so the question text and the choices visually read as one unit
        // instead of an orphan card floating below.
        'mt-0 mb-2 mx-2 rounded-md border bg-card p-3 space-y-2',
        'border-primary/30 shadow-sm',
        locked && 'opacity-60'
      )}
      data-testid={`ask-inline:${ask.askId}`}
      data-locked={locked || undefined}
    >
      <div className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
        <HelpCircle className='size-3.5 text-primary' />
        <span>
          {ask.type === 'confirm'
            ? t('devStudio.ask.confirmTitle')
            : t('devStudio.ask.notificationTitle')}
        </span>
      </div>
      {ask.type === 'choice' && (
        <ChoiceBody ask={ask} busy={inputsDisabled} onAnswer={postAnswer} />
      )}
      {ask.type === 'confirm' && (
        <ConfirmBody ask={ask} busy={inputsDisabled} onAnswer={postAnswer} />
      )}
      {ask.type === 'text' && (
        <TextBody
          ask={ask}
          busy={inputsDisabled}
          value={textValue}
          onChange={setTextValue}
          onAnswer={postAnswer}
        />
      )}
      {locked && (
        <div className='text-xs text-muted-foreground italic'>
          {t('devStudio.ask.inlineLockedHint')}
        </div>
      )}
      {error && <div className='text-xs text-destructive'>{error}</div>}
    </div>
  )
}

function ChoiceBody({
  ask,
  busy,
  onAnswer,
}: {
  ask: Ask & { type: 'choice' }
  busy: boolean
  onAnswer: (answer: unknown, summary: string) => void
}) {
  const { t } = useTranslation()
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  return (
    <>
      <p className='text-sm text-foreground'>{ask.question}</p>
      <div className='flex flex-wrap gap-2'>
        {ask.options.map((opt) => (
          <Button
            key={opt.value}
            type='button'
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => onAnswer({ value: opt.value }, opt.label)}
            data-testid={`ask-inline:choice:${ask.askId}:${opt.value}`}
          >
            {opt.label}
          </Button>
        ))}
        {/* "Other" escape hatch — operators routinely want to answer with
            something the AI didn't pre-enumerate (e.g. "all of the above"
            or "none, do X instead"). Clicking unfurls a textarea below;
            submitting posts the trimmed string as the answer value. */}
        <Button
          type='button'
          size='sm'
          variant='ghost'
          disabled={busy}
          onClick={() => setOtherOpen((v) => !v)}
          data-testid={`ask-inline:choice:${ask.askId}:other`}
          aria-pressed={otherOpen}
        >
          {t('devStudio.ask.choiceOther')}
        </Button>
      </div>
      {otherOpen && (
        <div className='space-y-2'>
          <textarea
            className='w-full min-h-[50px] rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            value={otherText}
            placeholder={t('devStudio.ask.choiceOtherPlaceholder')}
            disabled={busy}
            onChange={(e) => setOtherText(e.target.value)}
            data-testid={`ask-inline:choice:${ask.askId}:other-input`}
          />
          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              disabled={busy || otherText.trim().length === 0}
              onClick={() => onAnswer({ value: otherText.trim() }, otherText.trim())}
              data-testid={`ask-inline:choice:${ask.askId}:other-submit`}
            >
              {t('devStudio.ask.choiceOtherSubmit')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function ConfirmBody({
  ask,
  busy,
  onAnswer,
}: {
  ask: Ask & { type: 'confirm' }
  busy: boolean
  onAnswer: (answer: unknown, summary: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <p className='text-sm text-foreground'>{ask.question}</p>
      <div className='flex gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy}
          onClick={() => onAnswer({ value: true }, t('devStudio.ask.confirmYes'))}
          data-testid={`ask-inline:confirm:${ask.askId}:yes`}
        >
          {t('devStudio.ask.confirmYes')}
        </Button>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={busy}
          onClick={() => onAnswer({ value: false }, t('devStudio.ask.confirmNo'))}
          data-testid={`ask-inline:confirm:${ask.askId}:no`}
        >
          {t('devStudio.ask.confirmNo')}
        </Button>
      </div>
    </>
  )
}

function TextBody({
  ask,
  busy,
  value,
  onChange,
  onAnswer,
}: {
  ask: Ask & { type: 'text' }
  busy: boolean
  value: string
  onChange: (v: string) => void
  onAnswer: (answer: unknown, summary: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <p className='text-sm text-foreground'>{ask.prompt}</p>
      <textarea
        className='w-full min-h-[60px] rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        value={value}
        placeholder={ask.placeholder ?? ''}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`ask-inline:text:${ask.askId}:input`}
      />
      <div className='flex justify-end gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy || value.trim().length === 0}
          onClick={() => onAnswer({ value }, value.trim())}
          data-testid={`ask-inline:text:${ask.askId}:submit`}
        >
          {busy ? t('devStudio.ask.inlineSubmitting') : t('devStudio.ask.textSubmit')}
        </Button>
      </div>
    </>
  )
}
