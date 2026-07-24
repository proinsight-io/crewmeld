'use client'

import { useEffect, useRef, useState } from 'react'
import { PackageCheck, X } from 'lucide-react'
import { mutate } from 'swr'
import useSWR from 'swr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/use-translation'

const NOTIFICATIONS_URL = '/api/employee/dev-studio/notifications'

/** A single dependency-review library row, as returned by `GET /sessions/:id/dependencies`. */
export interface ReviewLibrary {
  name: string
  version: string
  raw: string
}

/** A single editable entry in the domain or IP allow-list. */
export interface EgressItem {
  /** The domain name or IP/CIDR value. */
  value: string
  /** Whether this entry is selected for inclusion in the egress allow-list. */
  checked: boolean
}

/** Payload from `GET /sessions/:id/dependencies`. */
export interface ReviewPayload {
  libraries: ReviewLibrary[]
  pendingLibraries: ReviewLibrary[]
  domains: string[]
  ips: string[]
  /** Domains discovered by static code scanning (subset of `domains`). */
  scannedDomains: string[]
  /** IPs discovered by static code scanning (subset of `ips`). */
  scannedIps: string[]
  globals: string[]
  needsReview: boolean
}

interface CardProps {
  /** Pending (non-global, unapproved) libraries needing approval. */
  libraries: ReviewLibrary[]
  /** Editable domain entries with checked state. */
  domainItems: EgressItem[]
  /** Editable IP entries with checked state. */
  ipItems: EgressItem[]
  /** Domains that originated from static code scanning (shown with a badge). */
  scannedDomains: string[]
  /** IPs that originated from static code scanning (shown with a badge). */
  scannedIps: string[]
  /** Called when the user toggles the checkbox on a domain entry. */
  onToggleDomain: (value: string) => void
  /** Called when the user removes a domain entry from the list. */
  onRemoveDomain: (value: string) => void
  /** Called when the user adds a new domain from the text input. */
  onAddDomain: (value: string) => void
  /** Called when the user toggles the checkbox on an IP entry. */
  onToggleIp: (value: string) => void
  /** Called when the user removes an IP entry from the list. */
  onRemoveIp: (value: string) => void
  /** Called when the user adds a new IP from the text input. */
  onAddIp: (value: string) => void
  busy: boolean
  error?: string | null
  onApprove: () => void
  onCancel: () => void
}

/**
 * Editable approval card shown inline in the chat. Lists the libraries that
 * genuinely need approval, plus editable/selectable domain and IP entries for
 * the egress allow-list. The user can check/uncheck or manually add/remove
 * entries before confirming. Confirming writes the selected entries into the
 * tool manifest via `PUT /egress`, then posts `/approve`.
 */
export function DependencyReviewCard({
  libraries,
  domainItems,
  ipItems,
  scannedDomains,
  scannedIps,
  onToggleDomain,
  onRemoveDomain,
  onAddDomain,
  onToggleIp,
  onRemoveIp,
  onAddIp,
  busy,
  error = null,
  onApprove,
  onCancel,
}: CardProps) {
  const { t } = useTranslation()
  const [newDomain, setNewDomain] = useState('')
  const [newIp, setNewIp] = useState('')

  function handleAddDomain() {
    const trimmed = newDomain.trim()
    if (!trimmed) return
    onAddDomain(trimmed)
    setNewDomain('')
  }

  function handleAddIp() {
    const trimmed = newIp.trim()
    if (!trimmed) return
    onAddIp(trimmed)
    setNewIp('')
  }

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

      {libraries?.length > 0 && (
        <div className='text-xs' data-testid='dev-studio:dep-review:libs'>
          <span className='font-semibold text-muted-foreground'>
            {t('devStudio.dependencyReview.librariesLabel')}:
          </span>{' '}
          <span className='font-mono'>{libraries.map((l) => l.raw).join(', ')}</span>
        </div>
      )}

      {/* Egress hint: explains that this only writes to the current tool manifest */}
      {(domainItems.length > 0 || ipItems.length > 0) && (
        <p className='text-xs text-muted-foreground' data-testid='dev-studio:dep-review:egress-hint'>
          {t('devStudio.dependencyReview.egressHint')}
        </p>
      )}

      {domainItems.length > 0 && (
        <div className='space-y-1' data-testid='dev-studio:dep-review:domains'>
          <span className='text-xs font-semibold text-muted-foreground'>
            {t('devStudio.dependencyReview.domainsEditLabel')}:
          </span>
          {domainItems.map((item) => (
            <div
              key={item.value}
              className='flex items-center gap-2 text-xs'
              data-testid={`dev-studio:dep-review:domain:${item.value}`}
            >
              <Checkbox
                checked={item.checked}
                onCheckedChange={() => onToggleDomain(item.value)}
                disabled={busy}
                id={`domain-${item.value}`}
                data-testid={`dev-studio:dep-review:domain-checkbox:${item.value}`}
              />
              <span className='font-mono flex-1'>{item.value}</span>
              {scannedDomains.includes(item.value) && (
                <Badge variant='secondary' className='text-xs py-0 px-1 h-4'>
                  {t('devStudio.dependencyReview.scannedBadge')}
                </Badge>
              )}
              <button
                type='button'
                aria-label={t('devStudio.dependencyReview.cancel')}
                disabled={busy}
                onClick={() => onRemoveDomain(item.value)}
                className='text-muted-foreground hover:text-destructive disabled:opacity-50'
                data-testid={`dev-studio:dep-review:remove-domain:${item.value}`}
              >
                <X className='size-3' />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className='flex gap-1'>
        <Input
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddDomain()
          }}
          placeholder={t('devStudio.dependencyReview.domainsEditLabel')}
          disabled={busy}
          className='h-7 text-xs'
          data-testid='dev-studio:dep-review:add-domain'
        />
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={busy || !newDomain.trim()}
          onClick={handleAddDomain}
          className='h-7 text-xs px-2'
        >
          {t('devStudio.dependencyReview.addDomain')}
        </Button>
      </div>

      {ipItems.length > 0 && (
        <div className='space-y-1' data-testid='dev-studio:dep-review:ips'>
          <span className='text-xs font-semibold text-muted-foreground'>
            {t('devStudio.dependencyReview.ipsEditLabel')}:
          </span>
          {ipItems.map((item) => (
            <div
              key={item.value}
              className='flex items-center gap-2 text-xs'
              data-testid={`dev-studio:dep-review:ip:${item.value}`}
            >
              <Checkbox
                checked={item.checked}
                onCheckedChange={() => onToggleIp(item.value)}
                disabled={busy}
                id={`ip-${item.value}`}
              />
              <span className='font-mono flex-1'>{item.value}</span>
              {scannedIps.includes(item.value) && (
                <Badge variant='secondary' className='text-xs py-0 px-1 h-4'>
                  {t('devStudio.dependencyReview.scannedBadge')}
                </Badge>
              )}
              <button
                type='button'
                aria-label={t('devStudio.dependencyReview.cancel')}
                disabled={busy}
                onClick={() => onRemoveIp(item.value)}
                className='text-muted-foreground hover:text-destructive disabled:opacity-50'
                data-testid={`dev-studio:dep-review:remove-ip:${item.value}`}
              >
                <X className='size-3' />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className='flex gap-1'>
        <Input
          value={newIp}
          onChange={(e) => setNewIp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddIp()
          }}
          placeholder={t('devStudio.dependencyReview.ipsEditLabel')}
          disabled={busy}
          className='h-7 text-xs'
          data-testid='dev-studio:dep-review:add-ip'
        />
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={busy || !newIp.trim()}
          onClick={handleAddIp}
          className='h-7 text-xs px-2'
        >
          {t('devStudio.dependencyReview.addIp')}
        </Button>
      </div>

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
  /** External state marker that requests an immediate dependency revalidation when changed. */
  refreshKey?: string | number | null
}

/**
 * Builds a stable string key from the domain and IP arrays for use as a
 * `useEffect` dependency, so the editable state is only reset when the server
 * data actually changes (not on every SWR re-render).
 */
function buildEgressKey(domains: string[], ips: string[]): string {
  return JSON.stringify([...domains].sort()) + '|' + JSON.stringify([...ips].sort())
}

/**
 * Container that fetches the session's dependency review payload and renders
 * {@link DependencyReviewCard} as soon as there are non-global deps awaiting
 * approval (`needsReview`). Domain and IP entries from the server payload are
 * held in local editable state (`EgressItem[]`); the editable state is only
 * reset when the sorted domain/IP set changes on the server — SWR's periodic
 * re-polls that return the same set will NOT overwrite user edits. Confirming
 * first PUTs the selected entries to `/egress` (writes them into the manifest),
 * then POSTs to `/approve`. Cancelling POSTs to `/reject`. Both revalidate the
 * review payload and the notifications aggregate.
 */
export function DependencyReviewInline({ sessionId, refreshKey = null }: InlineProps) {
  const { t } = useTranslation()
  const reviewUrl = sessionId
    ? `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies`
    : null
  const { data, mutate: revalidate } = useSWR<ReviewPayload>(reviewUrl, reviewFetcher, {
    refreshInterval: 30_000,
  })

  const [domainItems, setDomainItems] = useState<EgressItem[]>([])
  const [ipItems, setIpItems] = useState<EgressItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Track the last egress key we initialized from. When the key changes (i.e.
   * the server returned a different set of domains/IPs), reset the editable
   * state. When the key is unchanged (SWR re-poll with same data), leave user
   * edits intact.
   */
  const lastEgressKeyRef = useRef<string | null>(null)
  const previousRefreshKeyRef = useRef(refreshKey)

  useEffect(() => {
    if (previousRefreshKeyRef.current === refreshKey) return
    previousRefreshKeyRef.current = refreshKey
    void revalidate()
  }, [refreshKey, revalidate])

  useEffect(() => {
    if (!data) return
    const key = buildEgressKey(data.domains, data.ips)
    if (key === lastEgressKeyRef.current) return
    lastEgressKeyRef.current = key
    setDomainItems(data.domains.map((v) => ({ value: v, checked: true })))
    setIpItems(data.ips.map((v) => ({ value: v, checked: true })))
  }, [data])

  if (!sessionId || !data?.needsReview) return null

  /** Narrowed reference — TypeScript can't narrow across async closures, so we snapshot here. */
  const payload = data

  function toggleDomain(value: string) {
    setDomainItems((prev) =>
      prev.map((item) => (item.value === value ? { ...item, checked: !item.checked } : item))
    )
  }

  function removeDomain(value: string) {
    setDomainItems((prev) => prev.filter((item) => item.value !== value))
  }

  function addDomain(value: string) {
    if (domainItems.some((item) => item.value === value)) return
    setDomainItems((prev) => [...prev, { value, checked: true }])
  }

  function toggleIp(value: string) {
    setIpItems((prev) =>
      prev.map((item) => (item.value === value ? { ...item, checked: !item.checked } : item))
    )
  }

  function removeIp(value: string) {
    setIpItems((prev) => prev.filter((item) => item.value !== value))
  }

  function addIp(value: string) {
    if (ipItems.some((item) => item.value === value)) return
    setIpItems((prev) => [...prev, { value, checked: true }])
  }

  async function putEgress(): Promise<boolean> {
    if (!sessionId) return false
    const body = {
      domains: domainItems.filter((i) => i.checked).map((i) => i.value),
      ips: ipItems.filter((i) => i.checked).map((i) => i.value),
    }
    const res = await fetch(
      `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies/egress`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    return res.ok
  }

  async function post(path: 'approve' | 'reject', body: unknown): Promise<boolean> {
    if (!sessionId) return false
    const res = await fetch(
      `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    return res.ok
  }

  async function handleApprove() {
    setBusy(true)
    setError(null)
    try {
      const egressOk = await putEgress()
      if (!egressOk) {
        setError(t('devStudio.dependencyReview.egressFailed'))
        return
      }
      // Compute which scanned entries the operator rejected (scanned but not checked).
      // This covers both "unchecked" and "removed entirely" cases because removed
      // items no longer appear in domainItems at all, so they are absent from the
      // checked list.
      const checkedDomains = domainItems.filter((i) => i.checked).map((i) => i.value)
      const checkedIps = ipItems.filter((i) => i.checked).map((i) => i.value)
      const rejectedDomains = payload.scannedDomains.filter((d) => !checkedDomains.includes(d))
      const rejectedIps = payload.scannedIps.filter((ip) => !checkedIps.includes(ip))
      const approveOk = await post('approve', { rejectedDomains, rejectedIps })
      if (!approveOk) {
        setError(t('devStudio.dependencyReview.failed'))
        return
      }
      await Promise.all([mutate(reviewUrl), mutate(NOTIFICATIONS_URL)])
    } catch {
      setError(t('devStudio.dependencyReview.egressFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    setBusy(true)
    setError(null)
    try {
      const ok = await post('reject', {
        libraries: payload.pendingLibraries.map((l) => l.raw),
        domains: payload.domains,
        ips: payload.ips,
      })
      if (!ok) {
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
      libraries={payload.pendingLibraries}
      domainItems={domainItems}
      ipItems={ipItems}
      scannedDomains={payload.scannedDomains}
      scannedIps={payload.scannedIps}
      onToggleDomain={toggleDomain}
      onRemoveDomain={removeDomain}
      onAddDomain={addDomain}
      onToggleIp={toggleIp}
      onRemoveIp={removeIp}
      onAddIp={addIp}
      busy={busy}
      error={error}
      onApprove={handleApprove}
      onCancel={handleCancel}
    />
  )
}
