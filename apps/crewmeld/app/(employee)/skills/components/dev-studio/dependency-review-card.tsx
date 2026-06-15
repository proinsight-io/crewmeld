'use client'

import { useState } from 'react'
import { PackageCheck } from 'lucide-react'
import { mutate } from 'swr'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

const NOTIFICATIONS_URL = '/api/employee/dev-studio/notifications'

/** Payload from `GET /sessions/:id/dependencies`. */
interface ReviewPayload {
  libraries: Array<{ name: string; version: string; raw: string }>
  pendingLibraries: Array<{ name: string; version: string; raw: string }>
  domains: string[]
  globals: string[]
  needsReview: boolean
}

interface CardProps {
  /** Pending (non-global, unapproved) libraries needing approval. */
  libraries: Array<{ name: string; version: string; raw: string }>
  /** Pending domains (read-only). */
  domains: string[]
  busy: boolean
  error?: string | null
  onApprove: () => void
  onCancel: () => void
}

/**
 * Read-only approval card shown inline in the chat. Lists only the deps that
 * genuinely need approval — the tool's declared libraries minus globally preset
 * packages (which never need approval) minus already-approved ones — plus any
 * pending domains. Editing the actual dependency list (names/versions/add/remove)
 * lives in the test-panel dependency editor, not here; this card only gates
 * adoption via Approve / Cancel.
 */
export function DependencyReviewCard({
  libraries,
  domains,
  busy,
  error = null,
  onApprove,
  onCancel,
}: CardProps) {
  const { t } = useTranslation()
  return (
    <div
      className='mt-0 mb-2 mx-2 rounded-md border border-primary/30 bg-card p-3 space-y-2 shadow-sm'
      data-testid='dev-studio:dep-review'
    >
      <div className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
        <PackageCheck className='size-3.5 text-primary' />
        <span>{t('devStudio.dependencyReview.title')}</span>
      </div>
      <p className='text-xs text-muted-foreground'>{t('devStudio.dependencyReview.hint')}</p>

      {libraries.length > 0 && (
        <div className='text-xs' data-testid='dev-studio:dep-review:libs'>
          <span className='font-semibold text-muted-foreground'>
            {t('devStudio.dependencyReview.librariesLabel')}:
          </span>{' '}
          <span className='font-mono'>{libraries.map((l) => l.raw).join(', ')}</span>
        </div>
      )}
      {domains.length > 0 && (
        <div className='text-xs' data-testid='dev-studio:dep-review:domains'>
          <span className='font-semibold text-muted-foreground'>
            {t('devStudio.dependencyReview.domainsLabel')}:
          </span>{' '}
          <span className='font-mono'>{domains.join(', ')}</span>
        </div>
      )}

      {error && <div className='text-xs text-destructive'>{error}</div>}

      <div className='flex gap-2 pt-1'>
        <Button
          type='button'
          size='sm'
          disabled={busy}
          onClick={onApprove}
          data-testid='dev-studio:dep-review:approve'
        >
          {t('devStudio.dependencyReview.approve')}
        </Button>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={busy}
          onClick={onCancel}
          data-testid='dev-studio:dep-review:cancel'
        >
          {t('devStudio.dependencyReview.cancel')}
        </Button>
      </div>
    </div>
  )
}

async function reviewFetcher(url: string): Promise<ReviewPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`dependency review request failed (${res.status})`)
  return (await res.json()) as ReviewPayload
}

interface InlineProps {
  /** Active session id; the card is hidden until one is selected. */
  sessionId: string | null
}

/**
 * Container that fetches the session's dependency review payload and renders
 * {@link DependencyReviewCard} as soon as there are non-global deps awaiting
 * approval (`needsReview`) — it is intentionally NOT gated on the chat turn
 * being finished. The deps are written when the manifest lands (mid-stream),
 * the test panel surfaces them immediately, and the approval card now appears
 * in step rather than lagging until the whole turn settles. If the AI later
 * changes the dependency set, `needsReview` simply flips again and the card
 * returns. Approve POSTs to /approve (snapshots manifest deps as approved); Cancel
 * POSTs the pending entries to /reject (tells the AI to rewrite). Both then
 * revalidate the review payload and the notifications aggregate so the card
 * collapses and the adopt gate releases.
 */
export function DependencyReviewInline({ sessionId }: InlineProps) {
  const { t } = useTranslation()
  const reviewUrl = sessionId
    ? `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies`
    : null
  const { data } = useSWR<ReviewPayload>(reviewUrl, reviewFetcher, { refreshInterval: 30_000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!sessionId || !data?.needsReview) return null

  async function post(path: 'approve' | 'reject', body: unknown) {
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      if (!res.ok) {
        setError(t('devStudio.dependencyReview.failed'))
        return
      }
      await Promise.all([mutate(reviewUrl), mutate(NOTIFICATIONS_URL)])
    } catch {
      setError(t('devStudio.dependencyReview.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DependencyReviewCard
      libraries={data.pendingLibraries}
      domains={data.domains}
      busy={busy}
      error={error}
      onApprove={() => post('approve', {})}
      onCancel={() =>
        post('reject', {
          libraries: data.pendingLibraries.map((l) => l.raw),
          domains: data.domains,
        })
      }
    />
  )
}
