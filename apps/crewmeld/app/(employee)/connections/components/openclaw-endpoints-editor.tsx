'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { OpenclawEndpoint } from '@/lib/connectors/types'
import { OPENCLAW_ENDPOINTS_MAX } from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Recognise a server-masked token value (matches `maskSensitiveFields`).
 *
 * Treat any token containing `****` as masked; the PATCH route will swap it
 * back to the originally stored token at save time.
 */
export function isMaskedToken(token: string): boolean {
  return token.includes('****')
}

/** Produce an empty endpoint row. */
export function newEmptyEndpoint(): OpenclawEndpoint {
  return { label: '', url: '', token: '' }
}

interface OpenclawEndpointsEditorProps {
  value: OpenclawEndpoint[]
  onChange: (next: OpenclawEndpoint[]) => void
  /** Disable inputs (e.g. during save). */
  disabled?: boolean
}

/**
 * Multi-endpoint editor for OpenClaw connections.
 *
 * Each row carries a label + URL + token. The runtime picks one endpoint at
 * random per invocation and falls back to the rest on retryable failure.
 */
export function OpenclawEndpointsEditor({
  value,
  onChange,
  disabled = false,
}: OpenclawEndpointsEditorProps) {
  const { t } = useTranslation()

  // Guarantee at least one row so the UI never collapses to nothing.
  const endpoints = value.length > 0 ? value : [newEmptyEndpoint()]

  const update = (idx: number, patch: Partial<OpenclawEndpoint>) => {
    const next = endpoints.map((ep, i) => (i === idx ? { ...ep, ...patch } : ep))
    onChange(next)
  }

  const remove = (idx: number) => {
    if (endpoints.length <= 1) return
    onChange(endpoints.filter((_, i) => i !== idx))
  }

  const add = () => {
    if (endpoints.length >= OPENCLAW_ENDPOINTS_MAX) return
    onChange([...endpoints, newEmptyEndpoint()])
  }

  return (
    <div className='flex flex-col gap-2'>
      <label className='block font-medium text-gray-700 text-sm'>
        {t('connections.openclawEndpointsLabel')} <span className='text-red-500'>*</span>
      </label>

      <div className='flex flex-col gap-2'>
        {endpoints.map((ep, idx) => {
          const masked = isMaskedToken(ep.token)
          return (
            <div
              key={idx}
              className='flex items-start gap-2 rounded-lg border border-gray-200 p-3'
            >
              <div className='flex flex-1 flex-col gap-2'>
                <div className='flex flex-col gap-1'>
                  <label className='font-medium text-gray-600 text-xs'>
                    {t('connections.openclawEndpointFieldLabel')}
                  </label>
                  <Input
                    placeholder={t('connections.openclawEndpointLabelPh')}
                    value={ep.label}
                    onChange={(e) => update(idx, { label: e.target.value })}
                    disabled={disabled}
                    maxLength={32}
                  />
                </div>
                <div className='flex flex-col gap-1'>
                  <label className='font-medium text-gray-600 text-xs'>
                    {t('connections.openclawEndpointFieldUrl')}
                  </label>
                  <Input
                    placeholder='http://openclaw:18789'
                    value={ep.url}
                    onChange={(e) => update(idx, { url: e.target.value })}
                    disabled={disabled}
                  />
                </div>
                <div className='flex flex-col gap-1'>
                  <label className='font-medium text-gray-600 text-xs'>
                    {t('connections.openclawEndpointFieldToken')}
                  </label>
                  <Input
                    type={masked ? 'text' : 'password'}
                    placeholder={
                      masked
                        ? t('connections.openclawEndpointTokenMaskedPh')
                        : t('connections.openclawEndpointTokenPh')
                    }
                    value={ep.token}
                    onChange={(e) => update(idx, { token: e.target.value })}
                    disabled={disabled}
                  />
                </div>
              </div>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() => remove(idx)}
                disabled={disabled || endpoints.length <= 1}
                aria-label={t('connections.openclawRemoveEndpoint')}
                className={cn(
                  'text-gray-500 hover:text-red-600',
                  endpoints.length <= 1 && 'invisible'
                )}
              >
                <Trash2 className='h-4 w-4' />
              </Button>
            </div>
          )
        })}
      </div>

      <div className='flex items-center justify-between'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={add}
          disabled={disabled || endpoints.length >= OPENCLAW_ENDPOINTS_MAX}
        >
          <Plus className='mr-1 h-4 w-4' />
          {t('connections.openclawAddEndpoint')}
        </Button>
        <span className='text-gray-400 text-xs'>
          {endpoints.length}/{OPENCLAW_ENDPOINTS_MAX}
        </span>
      </div>

      <p className='text-gray-500 text-xs leading-relaxed'>
        {t('connections.openclawEndpointHint')}
      </p>
    </div>
  )
}
