'use client'

import { useCallback, useEffect, useState } from 'react'
import { createLogger } from '@crewmeld/logger'
import { useTranslation } from '@/hooks/use-translation'
import { SettingsTabs } from '../settings-tabs'

const logger = createLogger('SandboxSettingsPage')

type EgressMode = 'unrestricted' | 'allowlist'

interface SandboxSettings {
  presetPythonPackages: string[]
  allowedIps: string[]
  allowedDomains: string[]
  egressMode: EgressMode
}

const EMPTY: SandboxSettings = {
  presetPythonPackages: [],
  allowedIps: [],
  allowedDomains: [],
  egressMode: 'unrestricted',
}

/** UI uses raw string for textareas; we split on whitespace/comma when saving. */
interface FormState {
  presetPythonPackages: string
  allowedIps: string
  allowedDomains: string
  egressMode: EgressMode
}

function settingsToForm(s: SandboxSettings): FormState {
  return {
    presetPythonPackages: s.presetPythonPackages.join('\n'),
    allowedIps: s.allowedIps.join('\n'),
    allowedDomains: s.allowedDomains.join('\n'),
    egressMode: s.egressMode,
  }
}

function formToPayload(f: FormState): SandboxSettings {
  const split = (s: string) =>
    s
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  return {
    presetPythonPackages: split(f.presetPythonPackages),
    allowedIps: split(f.allowedIps),
    allowedDomains: split(f.allowedDomains),
    egressMode: f.egressMode,
  }
}

export default function SandboxSettingsPage() {
  const { t } = useTranslation()
  const [form, setForm] = useState<FormState>(settingsToForm(EMPTY))
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const res = await fetch('/api/employee/settings/sandbox')
      const data = await res.json()
      if (data.success) {
        setForm(settingsToForm(data.data as SandboxSettings))
      } else {
        setError(data.error ?? t('settings.sandboxFetchFailed'))
      }
    } catch (err) {
      logger.error('Failed to load sandbox settings', { error: err })
      setError(t('settings.sandboxFetchFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const flashToast = useCallback((kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleSave = useCallback(async () => {
    try {
      setIsSaving(true)
      const payload = formToPayload(form)
      const res = await fetch('/api/employee/settings/sandbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success) {
        flashToast('ok', t('settings.sandboxSaved'))
      } else {
        const detail =
          data.errors && Object.values(data.errors)[0]
            ? String(Object.values(data.errors)[0])
            : (data.error ?? t('settings.sandboxSaveFailed'))
        flashToast('err', detail)
      }
    } catch (err) {
      logger.error('Failed to save sandbox settings', { error: err })
      flashToast('err', t('settings.sandboxSaveFailed'))
    } finally {
      setIsSaving(false)
    }
  }, [form, flashToast, t])

  if (isLoading) {
    return (
      <div>
        <PageHeader />
        <SettingsTabs />
        <div className='space-y-4'>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className='animate-pulse rounded-xl border border-gray-200 bg-white p-5'
            >
              <div className='h-5 w-1/3 rounded bg-gray-200' />
              <div className='mt-3 h-20 w-full rounded bg-gray-100' />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader />
        <SettingsTabs />
        <div className='flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 py-12'>
          <p className='text-red-600 text-sm'>{error}</p>
          <button
            onClick={fetchSettings}
            className='rounded-lg bg-gray-600 px-4 py-2 font-medium text-sm text-white hover:bg-gray-700'
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  const allowlistActive = form.egressMode === 'allowlist'

  return (
    <div>
      <PageHeader />
      <SettingsTabs />

      <div className='space-y-6'>
        {/* Preset packages */}
        <Card title={t('settings.sandboxPresetSectionTitle')}
              desc={t('settings.sandboxPresetSectionDesc')}>
          <FieldArea
            label={t('settings.sandboxPresetPython')}
            desc={t('settings.sandboxPresetPythonDesc')}
            value={form.presetPythonPackages}
            placeholder={'requests\npandas\nnumpy'}
            onChange={(v) => setForm((p) => ({ ...p, presetPythonPackages: v }))}
            rows={4}
          />
        </Card>

        {/* Egress allowlist */}
        <Card title={t('settings.sandboxEgressSectionTitle')}
              desc={t('settings.sandboxEgressSectionDesc')}>
          <div>
            <h4 className='font-medium text-gray-900 text-sm'>
              {t('settings.sandboxEgressMode')}
            </h4>
            <p className='mt-1 mb-2 text-gray-500 text-xs'>
              {t('settings.sandboxEgressModeDesc')}
            </p>
            <div className='flex gap-4'>
              <ModeRadio
                checked={form.egressMode === 'unrestricted'}
                onChange={() => setForm((p) => ({ ...p, egressMode: 'unrestricted' }))}
                label={t('settings.sandboxEgressUnrestricted')}
              />
              <ModeRadio
                checked={form.egressMode === 'allowlist'}
                onChange={() => setForm((p) => ({ ...p, egressMode: 'allowlist' }))}
                label={t('settings.sandboxEgressAllowlist')}
              />
            </div>
            <p className='mt-2 text-amber-700 text-xs' data-testid='sandbox:egress-apply-hint'>
              {t('settings.sandboxEgressApplyHint')}
            </p>
          </div>

          <div
            className={`border-gray-100 border-t pt-6 transition-opacity ${allowlistActive ? '' : 'pointer-events-none opacity-40'}`}
          >
            <FieldArea
              label={t('settings.sandboxAllowedIps')}
              desc={t('settings.sandboxAllowedIpsDesc')}
              value={form.allowedIps}
              placeholder={'10.0.0.1\n192.168.1.0/24'}
              onChange={(v) => setForm((p) => ({ ...p, allowedIps: v }))}
              rows={3}
            />
            <FieldArea
              label={t('settings.sandboxAllowedDomains')}
              desc={t('settings.sandboxAllowedDomainsDesc')}
              value={form.allowedDomains}
              placeholder={'api.example.com\nopenai.com'}
              onChange={(v) => setForm((p) => ({ ...p, allowedDomains: v }))}
              rows={3}
            />
            <p className='mt-3 text-amber-700 text-xs'>{t('settings.sandboxNetworkPolicyHint')}</p>
          </div>
        </Card>

        <div>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className='rounded-lg bg-blue-600 px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50'
          >
            {isSaving ? t('settings.sandboxSaving') : t('settings.sandboxSaveBtn')}
          </button>
        </div>
      </div>

      {toast && (
        <div
          className={`-translate-x-1/2 fixed top-16 left-1/2 z-50 rounded-xl border px-5 py-3 shadow-lg ${
            toast.kind === 'ok'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span className='font-medium text-sm'>{toast.msg}</span>
        </div>
      )}
    </div>
  )
}

function PageHeader() {
  const { t } = useTranslation()
  return (
    <div className='mb-6'>
      <h1 className='font-bold text-2xl text-gray-900'>{t('settings.title')}</h1>
      <p className='mt-1 text-gray-500 text-sm'>{t('settings.sandboxSubtitle')}</p>
    </div>
  )
}

function Card({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-6 rounded-xl border border-gray-200 bg-white p-6'>
      <div>
        <h3 className='font-medium text-gray-900 text-sm'>{title}</h3>
        {desc && <p className='mt-1 text-gray-500 text-xs'>{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function FieldArea({
  label,
  desc,
  value,
  placeholder,
  onChange,
  rows,
}: {
  label: string
  desc: string
  value: string
  placeholder: string
  onChange: (v: string) => void
  rows: number
}) {
  return (
    <div className='border-gray-100 border-t pt-6 first:border-t-0 first:pt-0'>
      <h4 className='font-medium text-gray-900 text-sm'>{label}</h4>
      <p className='mt-1 mb-2 text-gray-500 text-xs'>{desc}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className='w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-gray-900 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
      />
    </div>
  )
}

function ModeRadio({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <label className='flex cursor-pointer items-center gap-2 text-gray-900 text-sm'>
      <input
        type='radio'
        checked={checked}
        onChange={onChange}
        className='h-4 w-4 cursor-pointer text-blue-600 focus:ring-blue-500'
      />
      <span>{label}</span>
    </label>
  )
}
