'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DevStudioInput } from '../dev-studio-input'
import { useOpencodeStream } from '../hooks/use-opencode-stream'
import { ResumeOverlay } from '../resume-overlay'
import { OpencodeMessage } from './opencode-message'
import { OpencodePermissionCard } from './opencode-permission-card'
import { OpencodeQuestionCard } from './opencode-question-card'
import { OpencodeRetryBanner } from './opencode-retry-banner'
import { OpencodeTodoPanel } from './opencode-todo-panel'
import { Loader2 } from 'lucide-react'

interface Props {
  /** The active opencode session identifier. */
  sessionId: string
  /**
   * Optional callback invoked whenever the stream's `busy` state changes.
   * Used by {@link DevStudioDialog} to gate the manifest auto-fix notification
   * on opencode being idle before dispatching a hidden correction prompt.
   */
  onBusyChange?: (busy: boolean) => void
  /** Container status from the session row; drives the resume overlay. */
  containerStatus?: string
  /** 'fork' for an adopted baseline, 'rehydrate' for an active iteration. */
  resumeMode?: 'rehydrate' | 'fork'
  /** Fork handler (fork mode). */
  onFork?: () => Promise<void>
  /** Called after a successful rehydrate so the session list revalidates. */
  onResumed?: () => void
}

/**
 * Self-contained chat surface for opencode sessions.
 *
 * Connects to the opencode BFF SSE stream via {@link useOpencodeStream},
 * renders {@link OpencodeMessage} rows and an optional
 * {@link OpencodePermissionCard} when a permission request is pending, then
 * re-uses {@link DevStudioInput} for text input.
 *
 * This component must only be mounted when `coderType === 'opencode'` to
 * satisfy the Rules of Hooks constraint — the dialog switches between
 * `OpencodeChatSurface` and `ClaudeChatSurface` based on `coderType`, so each
 * hook is called unconditionally within its own component.
 *
 * The input is included here (rather than at dialog level) because the opencode
 * surface is self-contained: it owns its send/busy state and does not share a
 * stream handle with the dialog's action handlers.
 *
 * Auto-scroll behavior: new streaming content scrolls the viewport to the
 * bottom automatically. If the user scrolls up more than 48px from the bottom,
 * auto-scroll pauses. Scrolling back within 48px of the bottom re-enables it.
 */
export function OpencodeChatSurface({
  sessionId,
  onBusyChange,
  containerStatus,
  resumeMode = 'rehydrate',
  onFork,
  onResumed,
}: Props) {
  const { t } = useTranslation()
  const {
    messages,
    busy,
    connected,
    send,
    pendingPermission,
    replyPermission,
    pendingQuestion,
    answerQuestion,
    dismissQuestion,
    error,
    todos,
    retryStatus,
    reloadHistory,
  } = useOpencodeStream(sessionId)

  // Ref to the <ScrollArea> wrapper element — used to query the Radix viewport.
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  // Whether the viewport is currently pinned to the bottom.
  const stickToBottom = useRef<boolean>(true)

  // Resolve the Radix scroll viewport from the wrapper element.
  const getViewport = useCallback((): HTMLElement | null => {
    if (!scrollAreaRef.current) return null
    return scrollAreaRef.current.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]',
    )
  }, [])

  // Attach the scroll listener once the wrapper mounts.
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return

    const onScroll = () => {
      const { scrollHeight, scrollTop, clientHeight } = viewport
      // Within 48px of the bottom → remain (or re-enable) stick-to-bottom.
      stickToBottom.current = scrollHeight - scrollTop - clientHeight < 48
    }

    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [getViewport])

  // Report busy state changes up to the parent dialog so it can gate the
  // manifest auto-fix notification on the stream being idle.
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  // When the container transitions to running (after a rehydrate/fork), re-pull
  // history so the on-disk snapshot is replaced by the live REST timeline.
  const prevContainerStatusRef = useRef<string | undefined>(containerStatus)
  useEffect(() => {
    const prev = prevContainerStatusRef.current
    prevContainerStatusRef.current = containerStatus
    if (prev !== 'running' && containerStatus === 'running') {
      reloadHistory()
    }
  }, [containerStatus, reloadHistory])

  // Scroll to bottom whenever message list or overlays change, if pinned.
  useEffect(() => {
    if (!stickToBottom.current) return
    const viewport = getViewport()
    if (!viewport) return

    // Use rAF so the browser has painted the new DOM nodes before we measure.
    const rafId = requestAnimationFrame(() => {
      if (stickToBottom.current) {
        viewport.scrollTop = viewport.scrollHeight
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [messages, pendingQuestion, error, busy, retryStatus, getViewport])

  return (
    <div
      className='relative h-full min-h-0 flex flex-col'
      data-testid='dev-studio:opencode-chat-panel'
    >
      <ScrollArea
        ref={scrollAreaRef}
        className='flex-1 min-h-0'
        data-testid='dev-studio:opencode-chat-area'
      >
        <div className='px-3 py-3 flex flex-col gap-1'>
          {messages.length === 0 && !busy && (
            // Empty-state prompt on a fresh session, mirroring the claudecode
            // chat area so opencode operators get the same "what to type" nudge.
            <div
              className='text-center text-sm text-muted-foreground py-12'
              data-testid='dev-studio:opencode-empty'
            >
              {t('devStudio.chat.empty')}
            </div>
          )}
          {messages.map((m) => (
            <OpencodeMessage key={m.id} message={m} />
          ))}
          {pendingPermission && (
            <OpencodePermissionCard permission={pendingPermission} onReply={replyPermission} />
          )}
          {pendingQuestion && (
            <OpencodeQuestionCard
              question={pendingQuestion}
              onSubmit={answerQuestion}
              onDismiss={dismissQuestion}
            />
          )}
          {error && (
            <div
              className='my-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'
              data-testid='dev-studio:opencode-error'
            >
              <span className='font-medium'>{t('devStudio.opencode.status.errorPrefix')}</span>
              {error}
            </div>
          )}
          {retryStatus && <OpencodeRetryBanner retry={retryStatus} />}
          {connected && busy && !retryStatus && !pendingQuestion && !pendingPermission && (
            // "Working" indicator: a turn is in flight but nothing is on screen
            // to answer. Distinct from the !connected "connecting" hint below so
            // the operator can tell "AI is thinking" apart from "socket is down".
            // Suppressed while `retryStatus` is set — the retry banner replaces it.
            <div
              className='my-1 flex items-center gap-2 text-sm text-muted-foreground'
              data-testid='dev-studio:opencode-working'
            >
              <span className='flex gap-1'>
                <span className='size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]' />
                <span className='size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]' />
                <span className='size-1.5 rounded-full bg-current animate-bounce' />
              </span>
              {t('devStudio.opencode.status.working')}
            </div>
          )}
        </div>
      </ScrollArea>
      {/* Live todo list sits above the input, mirroring opencode's task dock */}
      <OpencodeTodoPanel todos={todos ?? []} busy={busy} />
      {!connected && (
        // Gate input until the SSE stream is live: a prompt sent while the
        // socket is down (fresh sandbox still booting opencode, or a dropped
        // connection mid-reconnect) would have its reply frames missed live.
        <div
          className='flex items-center gap-1.5 px-3 pt-1 text-xs text-muted-foreground'
          data-testid='dev-studio:opencode-connecting'
          aria-live='polite'
        >
          <Loader2 className='size-3 animate-spin' />
          <span>{t('devStudio.opencode.status.connecting')}</span>
        </div>
      )}
      <div className='relative'>
        <DevStudioInput
          busy={busy}
          disabled={!connected}
          disableWhenBusy
          isFirstMessage={messages.length === 0}
          sessionId={sessionId}
          onSend={send}
          onAbort={() => {
            // opencode does not support mid-stream abort via the current BFF.
          }}
        />
        {containerStatus && containerStatus !== 'running' && (
          <ResumeOverlay
            sessionId={sessionId}
            mode={resumeMode}
            onResumed={() => onResumed?.()}
            onFork={onFork}
          />
        )}
      </div>
    </div>
  )
}
