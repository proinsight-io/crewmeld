'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'
import { useDevStudioUI } from '@/stores/dev-studio-ui/store'
import { type CloseAction, CloseConfirmDialog } from './close-confirm-dialog'
import { DevStudioChat } from './dev-studio-chat'
import { DevStudioHeader } from './dev-studio-header'
import { DevStudioInput } from './dev-studio-input'
import { useDevStudioSession } from './hooks/use-dev-studio-session'
import { useManifest } from './hooks/use-manifest'
import { useManifestFirstAppearance } from './hooks/use-manifest-first-appearance'
import { useSessionList } from './hooks/use-session-list'
import { useSplitRatio } from './hooks/use-split-ratio'
import { useStreamChat } from './hooks/use-stream-chat'
import { ResumeOverlay } from './resume-overlay'
import { SplitPane } from './split-pane'
import { WorkspacePanel } from './workspace-panel'

interface Props {
  open: boolean
  onClose: () => void
  /**
   * Optional pre-existing session id. When provided the dialog skips sandbox
   * creation and pivots straight to this session — used by the
   * NotificationCenter `/skills?devStudio=<id>` deep-link.
   */
  initialSessionId?: string | null
  /**
   * Optional tool id. When provided, the session list is filtered to sessions
   * linked to this tool, and a "New iteration" fork button is shown.
   */
  toolId?: string
}

/** Map of session error codes → translation keys. Looked up via t() at render time. */
const ERROR_TITLE_KEYS: Record<string, string> = {
  'sandbox-unreachable': 'devStudio.errors.sandboxUnreachable',
  'sandbox-timeout': 'devStudio.errors.sandboxTimeout',
  'config-missing': 'devStudio.errors.configMissing',
  network: 'devStudio.errors.network',
}

/**
 * Chat-only single-column body (used when the active session has not opted
 * into the workspace side panel).
 */
function ChatPanel({
  messages,
  sessionId,
  onAskAnswered,
  busy,
}: {
  messages: ReturnType<typeof useStreamChat>['messages']
  sessionId: string | null
  onAskAnswered: () => void
  busy: boolean
}) {
  // h-full (not flex-1) because the SplitPane slot wrapping this is a
  // plain block (h-full overflow-hidden), not a flex container — flex-1
  // there silently resolves to height:auto and the ScrollArea inside
  // collapses to zero, killing both visibility and the ability to scroll.
  return (
    <div className='h-full min-h-0 flex flex-col' data-testid='dev-studio:chat-panel'>
      <DevStudioChat
        messages={messages}
        sessionId={sessionId}
        onAskAnswered={onAskAnswered}
        busy={busy}
      />
    </div>
  )
}

export function DevStudioDialog({ open, onClose, initialSessionId, toolId }: Props) {
  const { t } = useTranslation()
  const setDialogOpen = useDevStudioUI((s) => s.setDialogOpen)
  // Broadcast open/closed so peer surfaces (today: NotificationCenter) can
  // hide themselves while the operator is inside the dialog and would
  // otherwise see duplicate ask cards in the corner.
  useEffect(() => {
    setDialogOpen(open)
    return () => setDialogOpen(false)
  }, [open, setDialogOpen])
  const session = useDevStudioSession(open, { initialSessionId, toolId })
  const chat = useStreamChat(session.sessionId)
  const sessionListOpts = toolId ? { toolId } : undefined
  const { sessions, mutate: mutateSessions } = useSessionList(sessionListOpts)
  const sessionRecord = session.sessionId
    ? (sessions.find((s) => s.id === session.sessionId) ?? null)
    : null
  const showRightPanel = sessionRecord?.rightPanelVisible ?? false

  const split = useSplitRatio({ storageKey: 'dev-studio.split.ratio' })

  /**
   * Gates the dialog's close request behind a confirmation prompt. Set true by
   * the Radix `onOpenChange(false)` handler, cleared by either the operator
   * picking an action (which then drives `onClose`) or cancelling.
   */
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  // Guard against Radix's nested-dialog focus cascade: when the inner
  // CloseConfirmDialog unmounts, focus restoration can fire onOpenChange(false)
  // on the outer Dialog. This ref suppresses that spurious close during the
  // brief window between confirm-action and the next render.
  const suppressOuterCloseRef = useRef(false)
  /**
   * When switching sessions, we need to confirm what to do with the current
   * session first. This stores the target session id until the confirmation
   * resolves. `null` means the confirm was triggered by a dialog close, not
   * a session switch.
   */
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null)
  // Mid-session model switch: a switch recreates the container (~10-30s), so it
  // is gated behind a confirm. `pendingModelSwitch` holds the target until the
  // operator confirms; `switchingModel` disables the selector while in flight.
  const [pendingModelSwitch, setPendingModelSwitch] = useState<{
    sessionId: string
    modelConfigId: string | null
  } | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  // Gate the 5s polling on dialog open — otherwise SWR keeps hitting /manifest
  // after the dialog closes (the Radix Dialog can keep children mounted in some
  // animation states; passing null disables the SWR key entirely).
  const { isPresent: manifestPresent, mutate: mutateManifest } = useManifest(
    open ? session.sessionId : null
  )

  // First time the AI writes .crewmeld-studio/manifest.json for this session,
  // auto-open the right workspace panel so the operator sees the freshly
  // packaged tool. Previously this lived inside WorkspacePanel, but that
  // panel only mounts AFTER the right side is already open — chicken/egg.
  // Lift the trigger up here so we can flip rightPanelVisible from false→
  // true on the manifest's first appearance.
  const onManifestFirstAppear = useCallback(() => {
    const id = session.sessionId
    if (!id) return
    if (sessionRecord?.rightPanelVisible) return // already open
    void fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rightPanelVisible: true }),
    })
      .then(() => mutateSessions())
      .catch(() => {})
  }, [session.sessionId, sessionRecord?.rightPanelVisible, mutateSessions])
  useManifestFirstAppearance(session.sessionId, manifestPresent, onManifestFirstAppear)

  /**
   * Handle the close-confirm dialog's chosen action.
   *
   * - `background`: leave the container running and just hide the dialog.
   * - `adopt`: PATCH the session into the adopted state (BFF destroys the
   *   container + flips the row), revalidate the session list + manifest,
   *   then close.
   * - `discard` / `terminate`: DELETE the session (same effect — container
   *   destroyed, row archived). The two kinds are presentation-only.
   *
   * Network failures swallow the error here on purpose — the close-confirm
   * dialog itself is not equipped to surface inline errors and the operator
   * will see the stale state in the session list. A future revision can add
   * a toast if this proves noisy.
   */
  async function handleCloseConfirm(action: CloseAction) {
    const switchTarget = pendingSwitchId
    if (switchTarget) {
      suppressOuterCloseRef.current = true
      setTimeout(() => { suppressOuterCloseRef.current = false }, 100)
    }
    setCloseConfirmOpen(false)
    setPendingSwitchId(null)
    if (action.kind === 'cancel') return
    const id = session.sessionId
    if (action.kind === 'background') {
      if (switchTarget) {
        session.setSessionId(switchTarget)
      } else {
        onClose()
      }
      return
    }
    if (!id) {
      if (switchTarget) {
        session.setSessionId(switchTarget)
      } else {
        onClose()
      }
      return
    }
    try {
      if (action.kind === 'adopt') {
        await fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(id)}/adopt`, {
          method: 'PATCH',
        })
      } else {
        await fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
      }
      await mutateSessions()
      await mutateManifest()
    } finally {
      if (switchTarget) {
        session.setSessionId(switchTarget)
      } else {
        onClose()
      }
    }
  }

  /**
   * Decide whether the close request needs gating by the confirm prompt. Only
   * `ready` sessions have a live container worth preserving — `creating` and
   * `error` states have nothing to background or adopt, so we let the dialog
   * close directly without an extra click.
   */
  function requestClose() {
    if (session.status !== 'ready' || !session.sessionId) {
      onClose()
      return
    }
    setPendingSwitchId(null)
    setCloseConfirmOpen(true)
  }

  /**
   * Handle a session-switch request from the SessionSwitcher. If the current
   * session is live (status=ready), gate the switch behind the same
   * close-confirm dialog so the operator explicitly chooses what to do with
   * the in-progress work before pivoting away.
   */
  function handleSwitchRequest(targetId: string) {
    if (targetId === session.sessionId) return
    if (session.status !== 'ready' || !session.sessionId) {
      session.setSessionId(targetId)
      return
    }
    setPendingSwitchId(targetId)
    setCloseConfirmOpen(true)
  }

  /**
   * Handle the "+ new session" button. Creates a new session, then directly
   * switches to it — no close-confirm required because creating a session
   * implicitly backgrounds the current one (the BFF handles the container
   * lifecycle: the unique partial index ensures at most 1 running container,
   * so the old one is destroyed server-side when the new one starts).
   */
  async function handleCreateNew(modelConfigId: string | null) {
    try {
      // Abort any in-flight stream before destroying the old container,
      // otherwise the broken connection produces error frames that leak
      // into the new session's chat view.
      await chat.abort()
      const res = await fetch('/api/employee/dev-studio/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelConfigId }),
      })
      if (!res.ok) return
      const body = (await res.json()) as { sessionId: string }
      await mutateSessions()
      session.setSessionId(body.sessionId)
    } catch {
      await mutateSessions().catch(() => {})
    }
  }

  /**
   * Request a mid-session model switch. No-op when the target equals the
   * current model; otherwise opens the confirm prompt (the switch recreates
   * the container, so it's deliberately gated).
   */
  function handleSwitchModel(id: string, modelConfigId: string | null) {
    if ((sessionRecord?.modelConfigId ?? null) === modelConfigId) return
    setPendingModelSwitch({ sessionId: id, modelConfigId })
  }

  /** Confirmed model switch: PATCH /model recreates the container on the same dirs. */
  async function confirmModelSwitch() {
    const target = pendingModelSwitch
    setPendingModelSwitch(null)
    if (!target) return
    setSwitchingModel(true)
    try {
      await chat.abort()
      await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(target.sessionId)}/model`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelConfigId: target.modelConfigId }),
        }
      )
      await mutateSessions()
    } catch {
      await mutateSessions().catch(() => {})
    } finally {
      setSwitchingModel(false)
    }
  }

  /**
   * Fork the current tool into a new iteration session. Uses the first
   * available session id as the route param — the BFF actually looks up the
   * most recent adopted session for the given toolId, so the route param is
   * just for REST convention.
   */
  async function handleForkIteration() {
    if (!toolId) return
    const sourceSession = sessions[0]
    if (!sourceSession) return
    try {
      await chat.abort()
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sourceSession.id)}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId }),
        }
      )
      if (!res.ok) return
      const body = (await res.json()) as { sessionId: string }
      await mutateSessions()
      session.setSessionId(body.sessionId)
    } catch {
      await mutateSessions().catch(() => {})
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !suppressOuterCloseRef.current) requestClose()
      }}
    >
      <DialogContent
        className='!max-w-[90vw] w-[90vw] h-[90vh] p-0 flex flex-col gap-0'
        data-testid='dev-studio:dialog'
        onPointerDownOutside={(e) => {
          // The global notification center is a sibling portal mounted in
          // the employee layout (not inside this dialog). Radix treats any
          // pointerdown that lands there as "outside" → fires onOpenChange
          // → operator gets a close-confirm dialog every time they answer
          // an ask from the corner. Suppress those specifically so the
          // dialog only closes from genuine outside clicks.
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-testid="notification-center"]')) {
            e.preventDefault()
          }
        }}
      >
        {/* Visually hidden a11y labels — DevStudioHeader supplies the visible title */}
        <DialogTitle className='sr-only'>{t('devStudio.errors.a11yTitle')}</DialogTitle>
        <DialogDescription className='sr-only'>
          {t('devStudio.errors.a11yDescription')}
        </DialogDescription>
        <DevStudioHeader
          sessionId={session.sessionId}
          onSwitch={handleSwitchRequest}
          onCreateNew={handleCreateNew}
          onSwitchModel={handleSwitchModel}
          switchingModel={switchingModel}
          toolId={toolId}
          onForkIteration={toolId ? handleForkIteration : undefined}
        />

        {session.status === 'creating' && (
          <div className='flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground'>
            <Loader2 className='size-8 animate-spin' />
            <span>{t('devStudio.errors.creatingSandbox')}</span>
          </div>
        )}

        {session.status === 'error' && session.error && (
          <div className='flex-1 flex flex-col items-center justify-center gap-3 px-6'>
            <div className='text-base font-medium text-destructive'>
              {ERROR_TITLE_KEYS[session.error.error]
                ? t(ERROR_TITLE_KEYS[session.error.error])
                : t('devStudio.errors.createSandboxFailed')}
            </div>
            {session.error.detail && (
              <div className='text-xs text-muted-foreground max-w-md text-center'>
                {session.error.detail}
              </div>
            )}
            <div className='flex gap-2'>
              {session.error.retryable && (
                <Button onClick={session.retry} data-testid='dev-studio:retry-button'>
                  {t('devStudio.errors.retry')}
                </Button>
              )}
              <Button variant='outline' onClick={onClose}>
                {t('devStudio.errors.close')}
              </Button>
            </div>
          </div>
        )}

        {session.status === 'ready' && (
          <>
            <div className='flex-1 flex overflow-hidden'>
              {/* Always wrap in SplitPane so toggling the right panel never
                  remounts ChatPanel — that used to throw away scroll position
                  and re-render the entire message list. WorkspacePanel is
                  rendered lazily (only when sessionId exists), but the
                  ChatPanel slot stays stable across the toggle. */}
              <SplitPane
                leftPct={split.leftPct}
                onDragEnd={split.onDragEnd}
                showRight={showRightPanel}
              >
                <ChatPanel
                  messages={chat.messages}
                  sessionId={session.sessionId}
                  onAskAnswered={chat.resumeAfterAsk}
                  busy={chat.busy}
                />
                {session.sessionId ? (
                  <WorkspacePanel sessionId={session.sessionId} onAdoptSuccess={onClose} />
                ) : (
                  <div />
                )}
              </SplitPane>
            </div>
            <div className='relative'>
              <DevStudioInput
                busy={chat.busy}
                disabled={false}
                isFirstMessage={chat.isFirstMessage}
                sessionId={session.sessionId}
                onSend={chat.send}
                onAbort={chat.abort}
              />
              {sessionRecord && sessionRecord.containerStatus !== 'running' && (
                <ResumeOverlay
                  sessionId={sessionRecord.id}
                  onResumed={() => mutateSessions()}
                />
              )}
            </div>
          </>
        )}
      </DialogContent>
      <CloseConfirmDialog
        open={closeConfirmOpen}
        manifestPresent={manifestPresent}
        onConfirm={handleCloseConfirm}
        onCancel={() => {
          setCloseConfirmOpen(false)
          setPendingSwitchId(null)
        }}
      />
      <AlertDialog
        open={pendingModelSwitch !== null}
        onOpenChange={(o) => {
          if (!o) setPendingModelSwitch(null)
        }}
      >
        <AlertDialogContent data-testid='dev-studio:model-switch-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('devStudio.modelSwitch.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('devStudio.modelSwitch.confirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid='dev-studio:model-switch-dialog:cancel'>
              {t('devStudio.modelSwitch.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmModelSwitch}
              data-testid='dev-studio:model-switch-dialog:confirm'
            >
              {t('devStudio.modelSwitch.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
