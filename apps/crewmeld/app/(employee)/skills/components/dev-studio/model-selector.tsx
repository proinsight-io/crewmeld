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
 * configs as a flat list: each option shows the model's display name, with the
 * provider appended in muted text ONLY when it differs — so a model named after
 * its provider (e.g. "千帆编程" under provider "千帆编程") renders once instead
 * of as a confusing duplicated header + item. Used both at session-create time
 * and for mid-session model switching (Sub-spec C §5).
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

  // When the pinned model isn't in the loaded list yet (still loading, or a
  // stale config), fall back to a synthetic option from the session's label so
  // the trigger shows the current model instead of a blank selection.
  const showFallback = !!(value && currentLabel && !configs.some((c) => c.id === value))

  return (
    <Select value={value ?? undefined} onValueChange={(v) => onChange(v)} disabled={disabled}>
      <SelectTrigger className='h-8 w-[180px] text-xs' data-testid='dev-studio:model-selector'>
        <SelectValue placeholder={t('devStudio.modelSelector.label')} />
      </SelectTrigger>
      <SelectContent>
        {configs.map((c) => {
          const provider = c.providerMeta?.name ?? c.providerId
          const showProvider = provider && provider !== c.displayName
          return (
            <SelectItem
              key={c.id}
              value={c.id}
              data-testid={`dev-studio:model-selector:item:${c.id}`}
            >
              <span className='flex items-center gap-2'>
                <span className='truncate'>{c.displayName}</span>
                {showProvider && <span className='text-muted-foreground text-xs'>{provider}</span>}
              </span>
            </SelectItem>
          )
        })}
        {showFallback && value && (
          <SelectItem value={value} data-testid={`dev-studio:model-selector:item:${value}`}>
            {currentLabel}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}
