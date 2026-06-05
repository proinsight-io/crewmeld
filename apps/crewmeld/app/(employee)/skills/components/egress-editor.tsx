'use client'

import { useState } from 'react'
import { Check, Globe, Loader2, Network, Plus, X } from 'lucide-react'
import { mutate } from 'swr'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

interface Props {
  /** Tool template id (`tools.id`) — egress is per-template. */
  toolId: string
  initialDomains: string[]
  initialIps: string[]
  /** SWR key of the manifest fetch to revalidate after a successful save. */
  manifestKey?: string
}

const INPUT_CLASS =
  'min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60'

/**
 * Editable per-tool egress allow-list (domains + IPs), surfaced in the instance
 * editor before listing. Saves into the tool manifest via
 * `PUT /api/employee/skills/:toolId/egress`. The list only restricts traffic
 * when the admin global egress mode is `allowlist` (see sandbox settings) —
 * a hint states this so operators are not surprised in unrestricted mode.
 */
export function EgressEditor({ toolId, initialDomains, initialIps, manifestKey }: Props) {
  const { t } = useTranslation()
  const [domains, setDomains] = useState<string[]>(initialDomains)
  const [ips, setIps] = useState<string[]>(initialIps)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch(`/api/employee/skills/${encodeURIComponent(toolId)}/egress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domains: domains.map((d) => d.trim()).filter(Boolean),
          ips: ips.map((i) => i.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) {
        setError(t('skills.egressSaveFailed'))
        return
      }
      setSaved(true)
      if (manifestKey) await mutate(manifestKey)
    } catch {
      setError(t('skills.egressSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='space-y-3' data-testid='skills:egress-editor'>
      <div className='flex items-center gap-1.5'>
        <Network className='h-4 w-4 text-gray-500' />
        <p className='font-medium text-gray-700 text-sm'>{t('skills.egressTitle')}</p>
      </div>
      <p className='text-gray-500 text-xs'>{t('skills.egressHint')}</p>
      <p className='text-amber-700 text-xs'>{t('skills.egressRedeployHint')}</p>

      <StringList
        label={t('skills.egressDomainsLabel')}
        icon={<Globe className='h-3 w-3 text-blue-500' />}
        values={domains}
        onChange={setDomains}
        disabled={busy}
        kind='domain'
        placeholder='api.example.com'
      />
      <StringList
        label={t('skills.egressIpsLabel')}
        icon={<Network className='h-3 w-3 text-emerald-500' />}
        values={ips}
        onChange={setIps}
        disabled={busy}
        kind='ip'
        placeholder='10.0.0.0/24'
      />

      <div className='flex items-center gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy}
          onClick={save}
          data-testid='skills:egress:save'
        >
          {busy ? <Loader2 className='mr-1 size-3 animate-spin' /> : null}
          {busy ? t('skills.egressSaving') : t('skills.egressSave')}
        </Button>
        {saved && !error && (
          <span
            className='inline-flex items-center gap-1 text-emerald-600 text-xs'
            data-testid='skills:egress:saved'
          >
            <Check className='size-3.5' />
            {t('skills.egressSaved')}
          </span>
        )}
        {error && (
          <span className='text-destructive text-xs' data-testid='skills:egress:error'>
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** Editable list of free-text strings with add/remove. */
function StringList({
  label,
  icon,
  values,
  onChange,
  disabled,
  kind,
  placeholder,
}: {
  label: string
  icon: React.ReactNode
  values: string[]
  onChange: (next: string[]) => void
  disabled: boolean
  kind: 'domain' | 'ip'
  placeholder: string
}) {
  const { t } = useTranslation()
  return (
    <div className='space-y-1.5'>
      <p className='flex items-center gap-1 font-medium text-gray-500 text-xs'>
        {icon}
        {label}
      </p>
      {values.map((val, i) => (
        <div key={i} className='flex items-center gap-1.5'>
          <input
            className={INPUT_CLASS}
            value={val}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => onChange(values.map((v, idx) => (idx === i ? e.target.value : v)))}
            data-testid={`skills:egress:${kind}:${i}`}
          />
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-7 shrink-0'
            disabled={disabled}
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
            data-testid={`skills:egress:${kind}-remove:${i}`}
            aria-label={t('skills.egressRemove')}
          >
            <X className='size-3.5' />
          </Button>
        </div>
      ))}
      <Button
        type='button'
        size='sm'
        variant='ghost'
        disabled={disabled}
        onClick={() => onChange([...values, ''])}
        data-testid={`skills:egress:${kind}-add`}
      >
        <Plus className='mr-1 size-3.5' />
        {t('skills.egressAdd')}
      </Button>
    </div>
  )
}
