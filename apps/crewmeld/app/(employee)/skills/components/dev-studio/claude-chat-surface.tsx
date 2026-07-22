'use client'

import { useTranslation } from '@/hooks/use-translation'
import { DevStudioChat } from './dev-studio-chat'
import type { ChatMessage } from './hooks/use-stream-chat'
import { LoadingOverlay } from './loading-overlay'

interface Props {
  /** The active claudecode session identifier. */
  sessionId: string
  /** Message list from {@link useStreamChat}. */
  messages: ChatMessage[]
  /** True while a /chat request is in flight. */
  busy: boolean
  /**
   * True while persisted history is being fetched. Drives the history spinner
   * and is forwarded to the caller to gate input.
   */
  loadingHistory: boolean
  /** Called when an inline ask card is answered. */
  onAskAnswered: () => void
}

/**
 * Chat area for claudecode sessions (scroll area + history spinner only).
 *
 * Intentionally excludes DevStudioInput and ResumeOverlay — those stay at
 * dialog level so they span the full dialog width below the SplitPane, matching
 * the original layout. The dialog owns the {@link useStreamChat} call and
 * passes the derived state down as props.
 *
 * Extracted into a dedicated component so the dialog can satisfy the Rules of
 * Hooks constraint: OpencodeChatSurface (the sibling) calls `useOpencodeStream`;
 * keeping each hook inside its own component prevents conditional hook calls.
 *
 * Behavior is identical to the pre-extraction claude ChatPanel — no feature changes.
 */
export function ClaudeChatSurface({
  sessionId,
  messages,
  busy,
  loadingHistory,
  onAskAnswered,
}: Props) {
  const { t } = useTranslation()

  return (
    // h-full (not flex-1) because the SplitPane slot wrapping this is a plain
    // block (h-full overflow-hidden), not a flex container — flex-1 there
    // silently resolves to height:auto and the ScrollArea inside collapses to
    // zero, killing both visibility and the ability to scroll.
    <div className='relative h-full min-h-0 flex flex-col' data-testid='dev-studio:chat-panel'>
      <DevStudioChat
        messages={messages}
        sessionId={sessionId}
        onAskAnswered={onAskAnswered}
        busy={busy}
      />
      {/* History spinner — shown while a session's persisted timeline loads, but
          only before any message has rendered, so it covers the blank gap on
          first landing / session switch without flickering over an in-flight
          stream that has already started appending. */}
      {loadingHistory && messages.length === 0 && (
        <LoadingOverlay
          label={t('devStudio.loading.history')}
          testId='dev-studio:history-loading'
        />
      )}
    </div>
  )
}
