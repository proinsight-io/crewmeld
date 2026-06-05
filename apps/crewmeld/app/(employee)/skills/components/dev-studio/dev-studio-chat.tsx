'use client'

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslation } from '@/hooks/use-translation'
import { DependencyReviewInline } from './dependency-review-card'
import { DevStudioMessage } from './dev-studio-message'
import type { ChatMessage } from './hooks/use-stream-chat'

interface Props {
  messages: ChatMessage[]
  /** Needed by inline ask cards to POST `/answer-ask`. May be null briefly. */
  sessionId?: string | null
  /**
   * Forwarded to each inline ask card so a successful answer can trigger
   * a hidden sentinel send (BFF then drains the queued system note → AI
   * continues without manual prodding).
   */
  onAskAnswered?: () => void
  /**
   * True while a /chat request is in flight. Renders a "thinking…" spinner
   * row at the bottom of the message list whenever the latest visible
   * message is NOT a streaming assistant bubble — that bubble already has
   * its own cursor indicator, so showing both would be redundant. The
   * spinner covers the pre-first-token window where the chat would
   * otherwise look frozen.
   */
  busy?: boolean
}

export function DevStudioChat({
  messages,
  sessionId = null,
  onAskAnswered,
  busy = false,
}: Props) {
  const { t } = useTranslation()
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Real isAtBottom calculation against the ScrollArea's internal viewport.
  // An earlier attempt used IntersectionObserver against the bottom sentinel,
  // but its default root is the document viewport — the sentinel was always
  // considered "intersecting" inside the dialog, so isAtBottom got stuck on
  // true and every new chunk yanked the user back to the latest message
  // (felt to operators like "I can't scroll up at all"). Direct scroll-event
  // listening on the Radix viewport gives an accurate read.
  const isAtBottomRef = useRef(true)

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root) return
    const vp = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLDivElement | null
    if (!vp) return
    const update = () => {
      const threshold = 80
      isAtBottomRef.current = vp.scrollHeight - vp.scrollTop - vp.clientHeight < threshold
    }
    update()
    vp.addEventListener('scroll', update, { passive: true })
    return () => vp.removeEventListener('scroll', update)
  }, [])

  // Auto-scroll to bottom on new messages, but only when the user is already
  // pinned at the bottom. Use the viewport's native scrollTo so the smooth
  // scroll actually targets the Radix viewport's scroll, not the document.
  useEffect(() => {
    if (!isAtBottomRef.current) return
    const root = scrollRootRef.current
    if (!root) return
    const vp = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLDivElement | null
    // jsdom doesn't ship scrollTo on HTMLElement; fall back to scrollIntoView
    // (also jsdom-stubbed but at least doesn't throw).
    if (vp && typeof vp.scrollTo === 'function') {
      vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' })
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages.length])

  // Identify the most recent ask so earlier ask cards can render in a locked
  // state. The chat is supposed to focus the operator on the newest question
  // — an older unanswered ask is a stale prompt the AI no longer cares about.
  let latestAskId: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'ask') {
      latestAskId = m.askId
      break
    }
  }

  // Hide the spinner when the tail is already a live streaming bubble — its
  // own cursor indicator covers the same "AI is responding" beat. Show it in
  // every other busy state (no messages yet, last item is a tool_use / ask /
  // user echo, etc.) so the operator gets a heartbeat before the first
  // token lands.
  const last = messages[messages.length - 1]
  const tailIsStreaming = last?.kind === 'assistant_text' && last.streaming
  const showThinking = busy && !tailIsStreaming

  return (
    <ScrollArea ref={scrollRootRef} className='flex-1 min-h-0' data-testid='dev-studio:chat-area'>
      <div className='py-3 flex flex-col gap-1'>
        {messages.length === 0 && !busy ? (
          <div className='text-center text-sm text-muted-foreground py-12'>
            {t('devStudio.chat.empty')}
          </div>
        ) : (
          messages.map((m) => (
            <DevStudioMessage
              key={m.id}
              message={m}
              sessionId={sessionId}
              onAskAnswered={onAskAnswered}
              askLocked={m.kind === 'ask' && m.askId !== latestAskId}
            />
          ))
        )}
        {showThinking && (
          <div
            className='text-xs text-muted-foreground flex items-center gap-1.5 my-1 px-2'
            data-testid='dev-studio:chat-thinking'
            aria-live='polite'
          >
            <Loader2 className='size-3.5 animate-spin' />
            <span>{t('devStudio.chat.thinking')}</span>
          </div>
        )}
        {/* Package allow-list review — appears as soon as the AI has written a
            manifest with unapproved deps (in step with the test panel's
            dependency list), gating adoption until the operator approves or cancels.
            Not gated on the turn finishing, so it no longer lags the test page. */}
        <DependencyReviewInline sessionId={sessionId} />
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
