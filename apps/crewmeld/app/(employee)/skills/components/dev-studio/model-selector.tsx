'use client'

import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/use-translation'

/** Sentinel value for the "system default" option — Radix Select needs a non-empty string value. */
const DEFAULT_VALUE = '__system_default__'

/** Shape of one coding model config returned by GET /models?category=coding. */
interface CodingModelConfig {
  id: string
  displayName: string
  providerId: string
  providerMeta?: { name: string }
}

interface ModelSelectorProps {
  /** Currently-selected model_configs id, or null for the global-env default. */
  value: string | null
  /** Fired with the chosen model_configs id, or null for "system default". */
  onChange: (id: string | null) => void
  disabled?: boolean
  /**
   * Human label for the current model (from session.modelName). Shown on the
   * trigger until the coding-model list loads / when the pinned model is not in
   * the coding list (e.g. a stale config).
   */
  currentLabel?: string | null
}

/**
 * Coding-model picker for dev-studio. Lists active `category=coding` model
 * configs plus a "system default" entry (global env fallback). Used both at
 * session-create time and for mid-session model switching (Sub-spec C §5).
 */
export function ModelSelector({ value, onChange, disabled, currentLabel }: ModelSelectorProps) {
  const { t } = useTranslation()
  const [configs, setConfigs] = useState<CodingModelConfig[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/employee/models?category=coding&activeOnly=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const list = json?.data?.configs as CodingModelConfig[] | undefined
        if (!cancelled && Array.isArray(list)) setConfigs(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const options = configs.map((c) => ({
    value: c.id,
    label: `${c.providerMeta?.name ?? c.providerId} / ${c.displayName}`,
  }))
  // If the pinned model isn't in the loaded list yet (still loading, or a stale
  // config), synthesize an option from the session's label so the trigger shows
  // the current model instead of a blank selection.
  if (value && currentLabel && !options.some((o) => o.value === value)) {
    options.push({ value, label: currentLabel })
  }

  return (
    <Select
      value={value ?? DEFAULT_VALUE}
      onValueChange={(v) => onChange(v === DEFAULT_VALUE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className='h-8 w-[180px] text-xs' data-testid='dev-studio:model-selector'>
        <SelectValue placeholder={t('devStudio.modelSelector.label')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE} data-testid='dev-studio:model-selector:default'>
          {t('devStudio.modelSelector.systemDefault')}
        </SelectItem>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            data-testid={`dev-studio:model-selector:item:${o.value}`}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
