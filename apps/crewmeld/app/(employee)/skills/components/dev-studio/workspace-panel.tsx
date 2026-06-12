'use client'

import { useCallback, useState } from 'react'
import { ToastPortal } from '@/components/ui/toast-portal'
import { cn } from '@/lib/core/utils/cn'
import type { OnConnectionChange } from '@/lib/dev-studio/connection-context'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/use-translation'
import { FileTreePanel } from './file-tree-panel'
import { useManifest } from './hooks/use-manifest'
import { useManifestFirstAppearance } from './hooks/use-manifest-first-appearance'
import { useManifestUpdate } from './hooks/use-manifest-update'
import { ReadmePanel } from './readme-panel'
import { TestPanel } from './test-panel'

interface WorkspacePanelProps {
  /** Currently displayed session id, or `null` when none is selected. */
  sessionId: string | null
  /**
   * Optional callback the test-panel uses to notify a successful adoption —
   * passed through to {@link TestPanel} so the outer dev-studio dialog can
   * tear down its chrome once the container is destroyed.
   */
  onAdoptSuccess?: () => void
  /** Session-bound system connection id (shared with the header selector). */
  connectionId?: string | null
  /** Fired when the test-panel picker changes the bound connection. */
  onConnectionChange?: OnConnectionChange
}

type WorkspaceTab = 'files' | 'test' | 'readme'

/**
 * Tab definitions. Labels are resolved at render time via t() — keep the order
 * stable so the rendered tab order is reproducible across locales.
 */
const TAB_DEFS: ReadonlyArray<{ id: WorkspaceTab; labelKey: string; icon: string }> = [
  { id: 'files', labelKey: 'devStudio.tabs.files', icon: '📂' },
  { id: 'test', labelKey: 'devStudio.tabs.test', icon: '🧪' },
  { id: 'readme', labelKey: 'devStudio.tabs.readme', icon: '📖' },
]

/**
 * Right-pane workspace container.
 *
 * Always renders the same 3 tabs (Files / Test / Docs). Visibility of the
 * panel as a whole is controlled by the parent (via `sessions.rightPanelVisible`).
 *
 * The first time a manifest appears for the current session, we automatically
 * switch to the Test tab and emit a toast — that's the canonical "AI delivered the tool"
 * moment for the operator. {@link useManifestFirstAppearance} latches by
 * session id so re-renders / SWR revalidation don't fire the toast twice.
 */
export function WorkspacePanel({
  sessionId,
  onAdoptSuccess,
  connectionId,
  onConnectionChange,
}: WorkspacePanelProps) {
  const { t } = useTranslation()
  const { manifest, isPresent, error: manifestError } = useManifest(sessionId)
  const [tab, setTab] = useState<WorkspaceTab>('files')
  const { toasts, showToast } = useToast()

  const onFirstAppear = useCallback(() => {
    setTab('test')
    showToast(t('devStudio.test.toastFirstPack'))
  }, [showToast, t])

  useManifestFirstAppearance(sessionId, isPresent, onFirstAppear)

  const onManifestUpdate = useCallback(() => {
    showToast(t('devStudio.test.toastUpdated'))
  }, [showToast, t])

  useManifestUpdate(sessionId, manifest, onManifestUpdate)

  if (!sessionId) {
    return (
      <div
        className='flex h-full items-center justify-center p-4 text-sm text-muted-foreground'
        data-testid='dev-studio:workspace-panel:empty'
      >
        {t('devStudio.emptyState.selectSession')}
      </div>
    )
  }

  return (
    <div className='flex h-full flex-col' data-testid='dev-studio:workspace-panel'>
      <div role='tablist' className='flex shrink-0 items-center justify-start gap-0 border-b'>
        {TAB_DEFS.map((def) => {
          const active = tab === def.id
          return (
            <button
              key={def.id}
              type='button'
              role='tab'
              aria-selected={active}
              onClick={() => setTab(def.id)}
              data-testid={`dev-studio:workspace-panel:tab:${def.id}`}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <span className='mr-1' aria-hidden='true'>
                {def.icon}
              </span>
              {t(def.labelKey)}
            </button>
          )
        })}
      </div>

      <div
        className={cn('flex-1 overflow-auto', tab === 'files' ? '' : 'hidden')}
        role='tabpanel'
        data-testid='dev-studio:workspace-panel:panel:files'
        hidden={tab !== 'files'}
      >
        <FileTreePanel sessionId={sessionId} />
      </div>
      <div
        className={cn('flex-1 overflow-auto', tab === 'test' ? '' : 'hidden')}
        role='tabpanel'
        data-testid='dev-studio:workspace-panel:panel:test'
        hidden={tab !== 'test'}
      >
        <TestPanel
          sessionId={sessionId}
          manifest={manifest}
          manifestError={manifestError}
          onAdoptSuccess={onAdoptSuccess}
          connectionId={connectionId ?? null}
          onConnectionChange={onConnectionChange}
        />
      </div>
      <div
        className={cn('flex-1 overflow-auto', tab === 'readme' ? '' : 'hidden')}
        role='tabpanel'
        data-testid='dev-studio:workspace-panel:panel:readme'
        hidden={tab !== 'readme'}
      >
        <ReadmePanel sessionId={sessionId} />
      </div>

      <ToastPortal toasts={toasts} />
    </div>
  )
}
