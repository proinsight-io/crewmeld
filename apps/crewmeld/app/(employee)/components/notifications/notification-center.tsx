'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useDevStudioUI } from '@/stores/dev-studio-ui/store'
import { AskChoiceCard } from './ask-choice-card'
import { AskConfirmCard } from './ask-confirm-card'
import { AskTextCard } from './ask-text-card'
import type { AskNotification, DependencyNotification } from './types'

const NOTIFICATIONS_URL = '/api/employee/dev-studio/notifications'

/** localStorage key holding the askIds the operator has dismissed ("got it"). */
const DISMISSED_KEY = 'crewmeld:dev-studio:dismissed-asks'

interface NotificationsPayload {
  dependencies: DependencyNotification[]
  asks: AskNotification[]
}

async function notificationsFetcher(url: string): Promise<NotificationsPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Notifications request failed (${res.status})`)
  return (await res.json()) as NotificationsPayload
}

function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function persistDismissed(ids: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore quota / serialization failures — dismissal is best-effort UX.
  }
}

interface AskCardProps {
  notification: AskNotification
  onOpen: () => void
  onDismiss: () => void
}

/** Renderer registry keyed on `ask.type`. Unknown types yield `null`. */
const ASK_CARD_MAP: Record<string, (props: AskCardProps) => React.ReactElement> = {
  choice: AskChoiceCard,
  confirm: AskConfirmCard,
  text: AskTextCard,
}

/**
 * Global viewport-anchored notification center mounted by the employee
 * layout.
 *
 * Polls `GET /api/employee/dev-studio/notifications` every 30s and stacks one
 * card per pending ask in the top-right corner. The cards are notify-only:
 * clicking "Answer" / the [↗] icon routes to `/skills?devStudio=<sessionId>`
 * (the SkillsPage opens the DevStudioDialog on that session, where the inline
 * card answers with full context and a live container). The ✕ button dismisses
 * a card locally — the ask stays pending in the DB so it remains answerable in
 * the workbench, but the corner stops nagging about it on this browser.
 *
 * Returns `null` when there is nothing pending so the layout stays unchanged
 * for users with quiet sessions.
 */
export function NotificationCenter() {
  const router = useRouter()
  const devStudioDialogOpen = useDevStudioUI((s) => s.dialogOpen)
  const { data } = useSWR<NotificationsPayload>(NOTIFICATIONS_URL, notificationsFetcher, {
    refreshInterval: 30_000,
  })
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed)

  // Dependency approval is handled by the inline review card in the dev-studio
  // chat, so the corner widget only surfaces pending asks. Filter unknown ask
  // types before any empty-check so a payload of only unsupported asks still
  // collapses the widget.
  const knownAsks = useMemo(
    () => (data?.asks ?? []).filter((a) => a.type in ASK_CARD_MAP),
    [data?.asks]
  )

  // Prune dismissed ids that are no longer pending, so the ignore list does not
  // grow unbounded and a re-asked question (same id, freshly pending) is not
  // permanently suppressed. Keyed on the sorted pending ids for a stable dep.
  const pendingKey = useMemo(
    () =>
      knownAsks
        .map((a) => a.askId)
        .sort()
        .join('|'),
    [knownAsks]
  )
  // Only prune once SWR has actually produced a payload — pruning against the
  // empty pre-load `knownAsks` would wrongly clear every dismissed id before
  // the pending list arrives.
  const dataLoaded = data !== undefined
  useEffect(() => {
    if (!dataLoaded) return
    setDismissed((prev) => {
      if (prev.size === 0) return prev
      const pendingIds = new Set(pendingKey ? pendingKey.split('|') : [])
      const next = new Set([...prev].filter((id) => pendingIds.has(id)))
      if (next.size === prev.size) return prev
      persistDismissed(next)
      return next
    })
  }, [dataLoaded, pendingKey])

  // While the dev-studio dialog is open, the operator already sees every
  // pending ask as an inline chat card — surfacing them again in the corner
  // duplicates UI and (worse) clicking a corner card outside the dialog portal
  // trips the close-confirm flow. Hide the whole widget for the duration.
  if (devStudioDialogOpen) return null

  const visibleAsks = knownAsks.filter((a) => !dismissed.has(a.askId))
  if (visibleAsks.length === 0) return null

  function openDevStudio(sessionId: string) {
    router.push(`/skills?devStudio=${sessionId}`)
  }

  function dismiss(askId: string) {
    setDismissed((prev) => {
      if (prev.has(askId)) return prev
      const next = new Set(prev).add(askId)
      persistDismissed(next)
      return next
    })
  }

  return (
    <div
      className='pointer-events-auto fixed top-4 right-4 z-[9999] flex max-w-sm flex-col gap-2'
      data-testid='notification-center'
    >
      {visibleAsks.map((a) => {
        const Card = ASK_CARD_MAP[a.type]
        return (
          <Card
            key={`ask-${a.sessionId}-${a.askId}`}
            notification={a}
            onOpen={() => openDevStudio(a.sessionId)}
            onDismiss={() => dismiss(a.askId)}
          />
        )
      })}
    </div>
  )
}
