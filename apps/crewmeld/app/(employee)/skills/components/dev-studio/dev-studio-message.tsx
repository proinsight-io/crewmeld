'use client'

import { AlertCircle, BookMarked, Bot, Octagon } from 'lucide-react'
import { MessageBubble } from '@/components/conversation/message-bubble'
import { cn } from '@/lib/core/utils/cn'
import { summarizeToolCall } from '@/lib/dev-studio/summarize-tool-call'
import { useTranslation } from '@/hooks/use-translation'
import { AskInlineCard } from './ask-inline-card'
import type { ChatMessage } from './hooks/use-stream-chat'

interface Props {
  message: ChatMessage
  /** Forwarded to inline ask cards so they can POST `/answer-ask`. */
  sessionId?: string | null
  /** Forwarded so the ask card can trigger a hidden resume send. */
  onAskAnswered?: () => void
  /**
   * True when this ask is no longer the latest one — only meaningful for
   * `kind: 'ask'` messages. Locks the card so the operator can't answer
   * a stale question after a newer one already arrived.
   */
  askLocked?: boolean
}

export function DevStudioMessage({
  message,
  sessionId = null,
  onAskAnswered,
  askLocked = false,
}: Props) {
  const { t } = useTranslation()
  switch (message.kind) {
    case 'user':
      return <MessageBubble id={message.id} role={'user' as const} content={message.text} />

    case 'assistant_text':
      return (
        <MessageBubble
          id={message.id}
          role={'assistant' as const}
          content={message.text}
          isStreaming={message.streaming}
        />
      )

    case 'system':
      return (
        <div className='text-xs text-muted-foreground flex items-center gap-1.5 my-1 px-2'>
          <Bot className='size-3.5' />
          <span>
            {message.model
              ? t('devStudio.chat.engineerReadyWithModel', { model: message.model })
              : t('devStudio.chat.engineerReady')}
          </span>
        </div>
      )

    case 'skill_loaded':
      return (
        <div className='text-xs text-muted-foreground flex items-center gap-1.5 my-1 px-2'>
          <BookMarked className='size-3.5' />
          <span>
            {t('devStudio.chat.skillLoaded')} <code className='font-mono'>{message.skill}</code>
          </span>
        </div>
      )

    case 'ask':
      return (
        <AskInlineCard
          sessionId={sessionId}
          ask={message.ask}
          onAnswered={onAskAnswered}
          locked={askLocked}
        />
      )

    case 'tool_use': {
      const summary = summarizeToolCall(message.name, message.input)
      const label = summary.labelKey
        ? t(summary.labelKey)
        : t('devStudio.chat.toolCall', { name: message.name })
      return (
        <details
          className='my-1 mx-2 rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900/50 dark:bg-yellow-950/30'
          onToggle={(e) => {
            // Only scroll when the expanded body actually lies below the
            // viewport — auto-scrolling on every toggle pushed cards that
            // were already visible (e.g. an ask card right after the tool
            // call) out of frame, and collapsing didn't restore their
            // position. Cheap visibility check: if the details' bottom is
            // already in view, leave the scroll position alone.
            const el = e.currentTarget as HTMLDetailsElement
            if (!el.open) return
            const rect = el.getBoundingClientRect()
            const viewportH = window.innerHeight || document.documentElement.clientHeight
            if (rect.bottom > viewportH) {
              el.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }
          }}
        >
          <summary className='cursor-pointer p-2 flex items-center gap-1.5 text-xs'>
            <span aria-hidden='true'>{summary.icon}</span>
            <span className='font-medium'>{label}</span>
            {summary.primary && (
              <span className='text-muted-foreground truncate flex-1 min-w-0'>
                {summary.primary}
              </span>
            )}
          </summary>
          <pre className='p-2 text-xs overflow-x-auto bg-yellow-100/50 dark:bg-yellow-950/50 rounded-b-md'>
            {JSON.stringify(message.input, null, 2)}
          </pre>
        </details>
      )
    }

    case 'tool_results': {
      const items = message.items
      const last = items[items.length - 1]
      const anyError = items.some((i) => i.isError)
      // Single-line preview of the latest result, trimmed to ~80 chars.
      const previewSource =
        typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      const preview =
        previewSource.length > 80
          ? `${previewSource.slice(0, 80).replace(/\s+/g, ' ')}…`
          : previewSource.replace(/\s+/g, ' ')
      const countLabel = items.length > 1 ? ` ×${items.length}` : ''
      const lastName = last.name ?? t('devStudio.chat.toolFallback')
      return (
        <details
          className={cn(
            'my-1 mx-2 rounded-md border',
            anyError
              ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30'
              : 'border-muted bg-muted/30'
          )}
          onToggle={(e) => {
            // Same conditional-scroll rationale as the tool_use details above.
            const el = e.currentTarget as HTMLDetailsElement
            if (!el.open) return
            const rect = el.getBoundingClientRect()
            const viewportH = window.innerHeight || document.documentElement.clientHeight
            if (rect.bottom > viewportH) {
              el.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }
          }}
        >
          <summary className='cursor-pointer p-2 text-xs flex items-center gap-1.5'>
            {anyError ? (
              <AlertCircle className='size-3.5 text-red-600 dark:text-red-400' />
            ) : (
              <span>📋</span>
            )}
            <span className='font-medium'>
              {t('devStudio.chat.toolReturned', { name: lastName, count: countLabel })}
            </span>
            <span className='text-muted-foreground truncate flex-1'>{preview}</span>
          </summary>
          <div className='border-t'>
            {items.map((it, idx) => (
              <div
                key={`${message.id}-r${idx}`}
                className={cn(
                  'p-2 border-b last:border-b-0 text-xs',
                  it.isError && 'bg-red-50/50 dark:bg-red-950/20'
                )}
              >
                <div className='text-muted-foreground font-medium mb-1'>
                  #{idx + 1} {it.name ?? t('devStudio.chat.toolFallback')}
                  {it.isError && t('devStudio.chat.toolErrorSuffix')}
                </div>
                <pre className='overflow-x-auto'>
                  {typeof it.content === 'string'
                    ? it.content
                    : JSON.stringify(it.content, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )
    }

    case 'error':
      return (
        <div className='my-2 mx-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-200 flex items-start gap-2'>
          <AlertCircle className='size-4 mt-0.5 flex-none' />
          <span>{message.text}</span>
        </div>
      )

    case 'aborted':
      return (
        <div className='text-xs text-muted-foreground italic my-1 px-2 flex items-center gap-1.5'>
          <Octagon className='size-3.5' />
          <span>{t('devStudio.chat.aborted')}</span>
        </div>
      )

    case 'result': {
      const parts: string[] = []
      if (typeof message.durationMs === 'number')
        parts.push(
          t('devStudio.chat.tokenDuration', { seconds: (message.durationMs / 1000).toFixed(1) })
        )
      if (typeof message.inputTokens === 'number')
        parts.push(t('devStudio.chat.tokenInput', { n: message.inputTokens }))
      if (typeof message.outputTokens === 'number')
        parts.push(t('devStudio.chat.tokenOutput', { n: message.outputTokens }))
      if (parts.length === 0) return null
      return (
        <div className='text-xs text-muted-foreground my-1 px-2'>
          {t('devStudio.chat.tokensThisRound', { parts: parts.join('，') })}
        </div>
      )
    }
  }
}
