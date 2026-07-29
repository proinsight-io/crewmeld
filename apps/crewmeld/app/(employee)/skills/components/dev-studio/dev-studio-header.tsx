'use client'

import { Sparkles } from 'lucide-react'
import type { OnConnectionChange } from '@/lib/dev-studio/connection-context'
import type { SessionRecord } from '@/lib/dev-studio/session-store'
import { ConnectionSelector } from './connection-selector'
import { ConnectionStatus } from './connection-status'
import { useSessionList } from './hooks/use-session-list'
import { ModelSelector } from './model-selector'
import { PhaseTimeline } from './phase-timeline'
import { RightPanelToggle } from './right-panel-toggle'
import { SessionSwitcher } from './session-switcher'
import { ToolMetaBar } from './tool-meta-bar'

interface DevStudioHeaderProps {
  /** Currently displayed session id, or `null` when none is selected. */
  sessionId: string | null
  /** Fresh row returned by session creation, before SWR's list revalidates. */
  sessionRecord?: SessionRecord | null
  /** Persisted right-panel state, optionally overridden by the active dialog. */
  rightPanelVisible?: boolean
  onRightPanelVisibleChange?: (visible: boolean) => void
  /** Pivot the dialog to a different session (see useDevStudioSession.setSessionId). */
  onSwitch: (id: string) => void
  /** Create a new session with the chosen coding model (null = system default). */
  onCreateNew: (modelConfigId: string | null) => void
  /** Switch the current session's coding model (recreates the container). */
  onSwitchModel: (sessionId: string, modelConfigId: string | null) => void
  /** True while a model switch is in flight — disables the selector. */
  switchingModel?: boolean
  /**
   * True while the model is generating a response. Disables both the model and
   * connection selectors so neither the model nor the bound connection can
   * change mid-turn.
   */
  busy?: boolean
  /** Currently-selected system connection id, or null. */
  selectedConnectionId?: string | null
  /** Fired when the operator picks (or clears) a system connection. */
  onConnectionChange?: OnConnectionChange
  /** Optional tool id filter for the session list. */
  toolId?: string
  /** Called when operator clicks "New iteration". Only present when toolId is set. */
  onForkIteration?: () => void
}

/**
 * Dev-studio dialog header bar.
 *
 * Composes the five Phase-11 sub-components into a single horizontal strip:
 *   [SessionSwitcher] [ToolMetaBar] ── PhaseTimeline ── [ConnectionStatus] [RightPanelToggle]
 *
 * Source of truth for `pipelinePhases` / `currentPhase` / `phaseHistory` is
 * the session row (DB-persisted + SWR-refreshed), not the streaming hook.
 * The latter could feed in-memory live updates but the DB row is the floor
 * truth that survives reloads and cross-tab moves, which is what we want
 * the header to show even when no stream is active.
 */
export function DevStudioHeader({
  sessionId,
  sessionRecord,
  rightPanelVisible,
  onRightPanelVisibleChange,
  onSwitch,
  onCreateNew,
  onSwitchModel,
  switchingModel,
  busy,
  selectedConnectionId,
  onConnectionChange,
  toolId,
  onForkIteration,
}: DevStudioHeaderProps) {
  const sessionListOpts = toolId ? { toolId } : undefined
  const { sessions } = useSessionList(sessionListOpts)
  const session = sessionId
    ? (sessionRecord ?? sessions.find((s) => s.id === sessionId) ?? null)
    : null

  return (
    <div
      className='flex items-center gap-3 border-b px-4 py-2 pr-10'
      data-testid='dev-studio:header'
    >
      <Sparkles className='size-4 text-primary shrink-0' aria-hidden='true' />
      <SessionSwitcher
        currentId={sessionId}
        onSwitch={onSwitch}
        onCreateNew={onCreateNew}
        toolId={toolId}
        onForkIteration={onForkIteration}
      />
      {sessionId && (
        <ModelSelector
          value={session?.modelConfigId ?? null}
          currentLabel={session?.modelName ?? null}
          onChange={(modelConfigId) => onSwitchModel(sessionId, modelConfigId)}
          disabled={busy || switchingModel || session?.containerStatus === 'creating'}
          triggerClassName='w-[240px]'
        />
      )}
      {sessionId && onConnectionChange && (
        <ConnectionSelector
          value={selectedConnectionId ?? null}
          onChange={onConnectionChange}
          disabled={busy || switchingModel || session?.containerStatus === 'creating'}
        />
      )}
      <ToolMetaBar sessionId={sessionId} />
      <div className='flex-1 min-w-0 overflow-x-auto'>
        {/* The phase timeline is driven by the claudecode-only `<phase>` /
            `<pipeline>` markers; opencode never emits them, so the strip would
            sit inert on the default 6-step pipeline. Render it only for
            claudecode and keep this flex-1 box as a spacer for opencode so the
            right-aligned controls stay put. */}
        {session?.coderType !== 'opencode' && (
          <PhaseTimeline
            pipelinePhases={session?.pipelinePhases ?? null}
            currentPhase={session?.phase ?? null}
            phaseHistory={session?.phaseHistory ?? []}
          />
        )}
      </div>
      <ConnectionStatus session={session} />
      <RightPanelToggle
        sessionId={sessionId}
        visible={rightPanelVisible ?? session?.rightPanelVisible ?? false}
        onVisibleChange={onRightPanelVisibleChange}
      />
    </div>
  )
}
