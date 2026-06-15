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
import { buildConnEnvKeys, type OnConnectionChange } from '@/lib/dev-studio/connection-context'
import { useTranslation } from '@/hooks/use-translation'
import { useDevStudioUI } from '@/stores/dev-studio-ui/store'
import { type CloseAction, CloseConfirmDialog } from './close-confirm-dialog'
import { CreateSessionDialog } from './create-session-dialog'
import { DevStudioChat } from './dev-studio-chat'
import { DevStudioHeader } from './dev-studio-header'
import { DevStudioInput } from './dev-studio-input'
import { useDevStudioSession } from './hooks/use-dev-studio-session'
import { useManifest } from './hooks/use-manifest'
import { useManifestFirstAppearance } from './hooks/use-manifest-first-appearance'
import { useSessionList } from './hooks/use-session-list'
import { useSplitRatio } from './hooks/use-split-ratio'
import { useStreamChat } from './hooks/use-stream-chat'
import { LoadingOverlay } from './loading-overlay'
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
  loadingHistory,
}: {
  messages: ReturnType<typeof useStreamChat>['messages']
  sessionId: string | null
  onAskAnswered: () => void
  busy: boolean
  loadingHistory: boolean
}) {
  const { t } = useTranslation()
  // h-full (not flex-1) because the SplitPane slot wrapping this is a
  // plain block (h-full overflow-hidden), not a flex container — flex-1
  // there silently resolves to height:auto and the ScrollArea inside
  // collapses to zero, killing both visibility and the ability to scroll.
  return (
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
  // Bound system connection for this session. Lifted here (rather than living
  // in the test panel) so the header selector and the test-panel picker share
  // a single source of truth, and so the connection context can be woven into
  // the model's first message / a mid-session prompt.
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  // Pre-composed connection note woven into the model's FIRST message when the
  // operator bound a connection before typing anything. Null otherwise.
  const [connectionInitialContext, setConnectionInitialContext] = useState<string | null>(null)
  const chat = useStreamChat(session.sessionId, connectionInitialContext)
  const sessionListOpts = toolId ? { toolId } : undefined
  const { sessions, mutate: mutateSessions } = useSessionList(sessionListOpts)
  const sessionRecord = session.sessionId
    ? (sessions.find((s) => s.id === session.sessionId) ?? null)
    : null
  const showRightPanel = sessionRecord?.rightPanelVisible ?? false

  // Hydrate the bound connection from the session row once it first loads for
  // the current session. Latched by session id so it applies the persisted
  // value on open / session-switch without clobbering a live operator change
  // (which already updates both the local state and the row).
  const loadedConnForSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const sid = session.sessionId
    if (!sid || !sessionRecord) return
    if (loadedConnForSessionRef.current === sid) return
    loadedConnForSessionRef.current = sid
    setSelectedConnectionId(sessionRecord.connectionId ?? null)
    setConnectionInitialContext(null)
  }, [session.sessionId, sessionRecord])

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
  // Container-spawning entry actions (~10-30s each). These gate a full-body
  // LoadingOverlay so the operator gets visible feedback instead of a frozen
  // dialog while a new container is created.
  const [forking, setForking] = useState(false)
  const [creatingNew, setCreatingNew] = useState(false)
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
      setTimeout(() => {
        suppressOuterCloseRef.current = false
      }, 100)
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
    setCreatingNew(true)
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
    } finally {
      setCreatingNew(false)
    }
  }

  /**
   * Handle a system-connection selection (from either the header selector or
   * the test-panel picker — they share this one handler).
   *
   * Three things happen:
   *  1. Update local state (drives both pickers + the test-run payload).
   *  2. Persist the choice on the session row so it survives reloads and the
   *     test-run sandbox can resolve the same connection.
   *  3. Surface the connection to the model:
   *     - Before the first message: stash a context note so the next first
   *       turn carries the connection's `CONN_*` variable names.
   *     - Mid-session (conversation already started): fire a hidden turn so
   *       the model proactively asks the operator what to do with it.
   *
   * Selectors are disabled while `chat.busy`, so a mid-session selection can
   * never race an in-flight turn; the `!chat.busy` guard is belt-and-braces.
   */
  const handleConnectionChange: OnConnectionChange = (id, info) => {
    setSelectedConnectionId(id)

    const keys = id && info ? buildConnEnvKeys(info.configPreview) : []
    const keyList = keys.join(', ')

    // First-message context — only meaningful while no turn has happened yet.
    setConnectionInitialContext(
      id && info
        ? t('devStudio.connectionContext.initial', {
            name: info.name,
            type: info.type,
            keys: keyList,
          })
        : null
    )

    // Persist on the session row (fire-and-forget; revalidate on success).
    const sid = session.sessionId
    if (sid) {
      void fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: id }),
      })
        .then(() => mutateSessions())
        .catch(() => {})
    }

    // Mid-session selection of a real connection → nudge the model to ask what
    // the operator wants to do with it. The hidden message is `[系统提示]`-
    // prefixed (single paragraph) so it is stripped from the chat on reload.
    // Requires a live container (chat 409s otherwise) and an already-started
    // conversation; a pre-first-message selection rides the first turn instead.
    if (
      id &&
      info &&
      !chat.isFirstMessage &&
      !chat.busy &&
      sessionRecord?.containerStatus === 'running'
    ) {
      const prompt = t('devStudio.connectionContext.midSession', {
        name: info.name,
        type: info.type,
        keys: keyList,
      })
      void chat.send(prompt, { hidden: true })
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
    setForking(true)
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
    } finally {
      setForking(false)
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
          busy={chat.busy}
          selectedConnectionId={selectedConnectionId}
          onConnectionChange={handleConnectionChange}
          toolId={toolId}
          onForkIteration={toolId ? handleForkIteration : undefined}
        />

        {session.status === 'resolving' && (
          <div
            className='flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground'
            data-testid='dev-studio:resolving'
          >
            <Loader2 className='size-8 animate-spin' />
            <span>{t('devStudio.loading.resolving')}</span>
          </div>
        )}

        {session.status === 'select-model' && (
          <div className='flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground'>
            <span>{t('devStudio.createSession.pickToStart')}</span>
          </div>
        )}

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
                  loadingHistory={chat.loadingHistory}
                />
                {session.sessionId ? (
                  <WorkspacePanel
                    sessionId={session.sessionId}
                    onAdoptSuccess={onClose}
                    connectionId={selectedConnectionId}
                    onConnectionChange={handleConnectionChange}
                  />
                ) : (
                  <div />
                )}
              </SplitPane>
            </div>
            <div className='relative'>
              <DevStudioInput
                busy={chat.busy}
                // Block sending until the persisted history (and the resumed
                // claude session id) finish loading. Otherwise a message sent
                // mid-load races the restore: the async `setMessages(restored)`
                // overwrites the just-started turn, so the reply silently
                // vanishes and a fresh claude session is started instead of
                // resuming. Surfaces only on session switch / reopen.
                disabled={chat.loadingHistory}
                isFirstMessage={chat.isFirstMessage}
                sessionId={session.sessionId}
                onSend={chat.send}
                onAbort={chat.abort}
              />
              {sessionRecord && sessionRecord.containerStatus !== 'running' && (
                <ResumeOverlay
                  sessionId={sessionRecord.id}
                  // Adopted originals cannot be rehydrated (BFF returns 410) — the
                  // overlay forks a fresh iteration off the baseline instead.
                  // Active iterations rehydrate their own suspended container.
                  mode={sessionRecord.status === 'adopted' && toolId ? 'fork' : 'rehydrate'}
                  onResumed={() => mutateSessions()}
                  onFork={toolId ? handleForkIteration : undefined}
                />
              )}
            </div>
          </>
        )}

        {/* Full-body overlays for container-recreating actions. Each leaves the
            view unchanged for ~10-30s, so without feedback the dialog looks
            frozen. Rendered last (and z-20) so they sit above the chat/input. */}
        {switchingModel && <LoadingOverlay label={t('devStudio.loading.switchingModel')} />}
        {forking && <LoadingOverlay label={t('devStudio.loading.forking')} />}
        {creatingNew && <LoadingOverlay label={t('devStudio.loading.creating')} />}
      </DialogContent>
      {/* Entry model-picker: shown when there is nothing to resume, instead of
          auto-creating a session with the deprecated global-env model. */}
      {/* Gate on `open` too: this is a separate portal dialog whose visibility
          would otherwise hinge solely on session.status — which the session
          hook does NOT reset when the (always-mounted) DevStudioDialog merely
          closes. Without the `open` guard, cancelling/closing the model picker
          left it orphaned on screen after the outer dialog had closed. */}
      <CreateSessionDialog
        open={open && session.status === 'select-model'}
        onConfirm={(modelConfigId) => session.startWithModel(modelConfigId)}
        onCancel={onClose}
      />

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
