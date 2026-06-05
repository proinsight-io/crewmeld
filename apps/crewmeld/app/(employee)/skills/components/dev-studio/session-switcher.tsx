'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { CreateSessionDialog } from './create-session-dialog'
import { useNotifications } from './hooks/use-notifications'
import { type UseSessionListOptions, useSessionList } from './hooks/use-session-list'

interface SessionSwitcherProps {
  /** Currently active session id, or `null` when none is selected. */
  currentId: string | null
  /** Invoked with the session id the operator wants to switch to. */
  onSwitch: (id: string) => void
  /**
   * Invoked when the operator confirms a new session, with the chosen coding
   * model (`modelConfigId`) or null for the system default.
   */
  onCreateNew: (modelConfigId: string | null) => void
  /** Optional toolId filter — when set, only sessions for this tool are shown. */
  toolId?: string
  /**
   * Called when the user clicks "New iteration". Only present when `toolId` is
   * set. The handler should call the fork API and switch to the new session.
   */
  onForkIteration?: () => void
}

/**
 * Header dropdown for switching between dev-studio sessions.
 *
 * Renders a trigger button showing the current session title and a panel with:
 *  - a client-side search input filtering by title (case-insensitive),
 *  - one row per session with status icon, two status badges (streaming + pending HITL),
 *    a last-message preview, and a delete button,
 *  - a "new session" button that calls `useSessionList.create` then switches,
 *  - an optional "new iteration" button when toolId is set.
 *
 * Streaming and pending state are surfaced via the notifications endpoint
 * (refreshed every 30s) — see {@link useNotifications}.
 */
export function SessionSwitcher({
  currentId,
  onSwitch,
  onCreateNew,
  toolId,
  onForkIteration,
}: SessionSwitcherProps) {
  const { t } = useTranslation()
  const sessionListOpts: UseSessionListOptions | undefined = toolId ? { toolId } : undefined
  const { sessions, remove } = useSessionList(sessionListOpts)
  const { dependencies, asks, pendingSessionIds } = useNotifications()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    hasToolId: boolean
  } | null>(null)
  // "+ new session" opens a model-pick dialog before creating.
  const [createOpen, setCreateOpen] = useState(false)

  // Streaming flag is per-session and reaches us through the notification
  // entries (dependencies + asks both carry a `streaming` boolean). Collapse
  // them into a single membership set for O(1) badge lookups per row.
  const streamingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const d of dependencies) if (d.streaming) ids.add(d.sessionId)
    for (const a of asks) if (a.streaming) ids.add(a.sessionId)
    return ids
  }, [dependencies, asks])

  const currentSession = currentId ? (sessions.find((s) => s.id === currentId) ?? null) : null
  const currentLabel =
    currentSession?.title?.trim() ||
    (currentId ? t('devStudio.header.untitled') : t('devStudio.header.noSelection'))

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return sessions
    return sessions.filter((s) => (s.title ?? '').toLowerCase().includes(needle))
  }, [sessions, search])

  // Close the dropdown on any outside click. The check is shallow on purpose:
  // a click anywhere outside the container collapses the panel — we want the
  // trigger itself to toggle, which it does via its onClick handler below.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (containerRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function onCreate() {
    setOpen(false)
    setCreateOpen(true)
  }

  function onItemClick(id: string) {
    setOpen(false)
    onSwitch(id)
  }

  function handleDeleteClick(e: React.MouseEvent, sessionId: string, hasToolId: boolean) {
    e.stopPropagation()
    setDeleteTarget({ id: sessionId, hasToolId })
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return
    try {
      await remove(deleteTarget.id)
    } catch {
      // Swallow — the session list will revalidate and show the stale state
    }
    setDeleteTarget(null)
  }

  return (
    <div ref={containerRef} className='relative'>
      <Button
        variant='outline'
        size='sm'
        type='button'
        onClick={() => setOpen((v) => !v)}
        data-testid='dev-studio:session-switcher:trigger'
        className='gap-1.5'
      >
        <span className='max-w-[160px] truncate'>{currentLabel}</span>
        <ChevronDown className='size-3.5 opacity-60' />
      </Button>
      {open && (
        <div
          className='absolute top-full left-0 z-50 mt-1 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-md'
          data-testid='dev-studio:session-switcher:panel'
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('devStudio.header.searchPlaceholder')}
            className='h-8 mb-2 text-sm'
            data-testid='dev-studio:session-switcher:search'
          />
          {toolId && onForkIteration && (
            <div className='mb-2'>
              <Button
                variant='outline'
                size='sm'
                type='button'
                onClick={() => {
                  setOpen(false)
                  onForkIteration()
                }}
                data-testid='dev-studio:session-switcher:fork'
                className='w-full justify-start gap-2'
              >
                <Plus className='size-4' />
                <span>{t('devStudio.session.newIteration')}</span>
              </Button>
            </div>
          )}
          <div className='max-h-72 overflow-y-auto'>
            {filtered.length === 0 ? (
              <div className='px-2 py-3 text-xs text-muted-foreground text-center'>
                {sessions.length === 0
                  ? t('devStudio.header.emptySessions')
                  : t('devStudio.header.noMatch')}
              </div>
            ) : (
              filtered.map((s) => {
                const isCurrent = s.id === currentId
                const streaming = streamingIds.has(s.id)
                const hasPending = pendingSessionIds.has(s.id)
                return (
                  <div
                    key={s.id}
                    role='button'
                    tabIndex={0}
                    onClick={() => onItemClick(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onItemClick(s.id)
                      }
                    }}
                    data-testid={`dev-studio:session-switcher:item:${s.id}`}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer group',
                      isCurrent && 'bg-accent/60 font-medium'
                    )}
                  >
                    {/* Status indicator dot */}
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full inline-block flex-shrink-0',
                        s.status === 'active' && 'bg-green-500',
                        s.status === 'adopted' && 'bg-blue-500',
                        s.status === 'archived' && 'bg-gray-400'
                      )}
                      data-testid={`dev-studio:session-switcher:status:${s.id}`}
                    />
                    <span className='flex items-center gap-1'>
                      {streaming && (
                        <Loader2
                          className='size-4 animate-spin text-primary'
                          data-testid={`dev-studio:session-switcher:streaming:${s.id}`}
                        />
                      )}
                      {hasPending && (
                        <span
                          className='size-2 rounded-full bg-destructive'
                          data-testid={`dev-studio:session-switcher:pending:${s.id}`}
                        />
                      )}
                    </span>
                    <div className='flex-1 min-w-0'>
                      <span className='truncate block'>
                        {s.title?.trim() || t('devStudio.header.untitled')}
                      </span>
                      <div className='text-xs text-muted-foreground truncate'>
                        {s.lastMessagePreview || t('devStudio.chat.empty')}
                      </div>
                    </div>
                    {/* Delete button — hidden by default, visible on hover */}
                    <Button
                      variant='ghost'
                      size='icon'
                      className='h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity'
                      onClick={(e) => handleDeleteClick(e, s.id, !!s.toolId)}
                      data-testid={`dev-studio:session-switcher:delete:${s.id}`}
                    >
                      <Trash2 className='h-3.5 w-3.5 text-muted-foreground' />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
          <div className='border-t mt-2 pt-2'>
            <Button
              variant='ghost'
              size='sm'
              type='button'
              onClick={onCreate}
              data-testid='dev-studio:session-switcher:create'
              className='w-full justify-start gap-2'
            >
              <Plus className='size-4' />
              <span>{t('devStudio.header.newSession')}</span>
            </Button>
          </div>
        </div>
      )}

      {/* New-session model picker */}
      <CreateSessionDialog
        open={createOpen}
        onConfirm={(modelConfigId) => {
          setCreateOpen(false)
          onCreateNew(modelConfigId)
        }}
        onCancel={() => setCreateOpen(false)}
      />

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent data-testid='dev-studio:session-delete-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('devStudio.session.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.hasToolId
                ? t('devStudio.session.deleteConfirmBodyWithTool')
                : t('devStudio.session.deleteConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid='dev-studio:session-delete-dialog:cancel'>
              {t('devStudio.closeConfirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              data-testid='dev-studio:session-delete-dialog:confirm'
            >
              {t('devStudio.session.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
