'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Package, Plus, X } from 'lucide-react'
import useSWR, { mutate } from 'swr'
import { Button } from '@/components/ui/button'
import { formatSpec } from '@/lib/dev-studio/dependency-spec'
import { useTranslation } from '@/hooks/use-translation'

interface ReviewPayload {
  libraries: Array<{ name: string; version: string; raw: string }>
  pendingLibraries: Array<{ name: string; version: string; raw: string }>
  domains: string[]
  globals: string[]
  needsReview: boolean
}

interface Row {
  name: string
  version: string
}

const INPUT_CLASS =
  'rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60'

async function fetcher(url: string): Promise<ReviewPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`dependency request failed (${res.status})`)
  return (await res.json()) as ReviewPayload
}

/**
 * Editable list of the tool's actual dependency packages, shown in the test
 * tab. Pre-filled from the session manifest; purely optional — the tool runs
 * off the existing manifest whether or not the operator edits or saves here.
 * Saving rewrites `manifest.dependencies.libraries` (and requirements.txt) via
 * `PUT /sessions/:id/dependencies/libraries`.
 */
export function DependencyListEditor({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/dependencies`
  const { data } = useSWR<ReviewPayload>(url, fetcher)

  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed/re-seed from the manifest whenever the server list changes identity.
  const signature = (data?.libraries ?? []).map((l) => l.raw).join('\n')
  const seededRef = useRef<string | null>(null)
  useEffect(() => {
    if (data && seededRef.current !== signature) {
      seededRef.current = signature
      setRows(data.libraries.map((l) => ({ name: l.name, version: l.version })))
    }
  }, [data, signature])

  if (!data) return null

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const libraries = rows
        .filter((r) => r.name.trim().length > 0)
        .map((r) => formatSpec({ name: r.name, version: r.version }))
      const res = await fetch(`${url}/libraries`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraries }),
      })
      if (!res.ok) {
        setError(t('devStudio.depList.saveFailed'))
        return
      }
      setSaved(true)
      await mutate(url)
    } catch {
      setError(t('devStudio.depList.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='space-y-2 border-t pt-3' data-testid='dev-studio:dep-list'>
      <div className='flex items-center gap-1.5 text-sm font-medium'>
        <Package className='size-4 text-muted-foreground' />
        <span>{t('devStudio.depList.title')}</span>
      </div>
      <p className='text-xs text-muted-foreground'>{t('devStudio.depList.hint')}</p>

      <div className='space-y-1.5'>
        {rows.map((row, i) => (
          <div key={i} className='flex items-center gap-1.5' data-testid={`dev-studio:dep-list:row:${i}`}>
            <input
              className={`${INPUT_CLASS} min-w-0 flex-1`}
              value={row.name}
              disabled={busy}
              placeholder={t('devStudio.depList.namePlaceholder')}
              onChange={(e) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))}
              data-testid={`dev-studio:dep-list:name:${i}`}
            />
            <input
              className={`${INPUT_CLASS} w-28`}
              value={row.version}
              disabled={busy}
              placeholder={t('devStudio.depList.versionPlaceholder')}
              onChange={(e) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, version: e.target.value } : r)))}
              data-testid={`dev-studio:dep-list:version:${i}`}
            />
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='size-7 shrink-0'
              disabled={busy}
              onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))}
              data-testid={`dev-studio:dep-list:remove:${i}`}
              aria-label={t('devStudio.depList.remove')}
            >
              <X className='size-3.5' />
            </Button>
          </div>
        ))}
        <Button
          type='button'
          size='sm'
          variant='ghost'
          disabled={busy}
          onClick={() => setRows((p) => [...p, { name: '', version: '' }])}
          data-testid='dev-studio:dep-list:add'
        >
          <Plus className='mr-1 size-3.5' />
          {t('devStudio.depList.add')}
        </Button>
      </div>

      <div className='flex items-center gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy}
          onClick={save}
          data-testid='dev-studio:dep-list:save'
        >
          {busy ? <Loader2 className='mr-1 size-3 animate-spin' /> : null}
          {busy ? t('devStudio.depList.saving') : t('devStudio.depList.save')}
        </Button>
        {saved && !error && (
          <span
            className='inline-flex items-center gap-1 text-emerald-600 text-xs'
            data-testid='dev-studio:dep-list:saved'
          >
            <Check className='size-3.5' />
            {t('devStudio.depList.saved')}
          </span>
        )}
        {error && (
          <span className='text-destructive text-xs' data-testid='dev-studio:dep-list:error'>
            {error}
          </span>
        )}
      </div>
    </div>
  )
}
