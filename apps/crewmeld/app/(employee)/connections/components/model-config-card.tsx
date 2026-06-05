'use client'

import { useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/core/utils/cn'
import type { ModelConfigData, ModelTestResult } from '@/lib/models/types'
import { type TranslationKey, useTranslation } from '@/hooks/use-translation'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

interface ModelConfigCardProps {
  config: ModelConfigData
  isAdmin?: boolean
  testResult?: ModelTestResult
  onEdit: (config: ModelConfigData) => void
  onDelete: (id: string) => void
  onTest: (id: string) => void
  onToggleActive: (config: ModelConfigData) => void
  onChat: (config: ModelConfigData) => void
}

const PROVIDER_COLORS: Record<string, string> = {
  qwen: 'bg-blue-600',
  ernie: 'bg-red-600',
  hunyuan: 'bg-purple-600',
}

export function ModelConfigCard({
  config,
  isAdmin = true,
  testResult,
  onEdit,
  onDelete,
  onTest,
  onToggleActive,
  onChat,
}: ModelConfigCardProps) {
  const { t } = useTranslation()
  const [showActions, setShowActions] = useState(false)

  const provider = PROVIDER_DEFINITIONS[config.providerId]
  const ProviderIcon = provider?.icon
  const providerName =
    t(`connections.providerName_${config.providerId}` as TranslationKey) || config.providerMeta.name
  const modelCount = config.providerMeta.models.length
  const isTesting = testResult?.message === t('connections.testingMessage')

  return (
    <div className='relative rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md'>
      <div className='mb-3 flex items-start justify-between'>
        <div className='flex items-center gap-3'>
          {ProviderIcon ? (
            <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100'>
              <ProviderIcon className='h-6 w-6' />
            </div>
          ) : (
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg font-bold text-sm text-white',
                PROVIDER_COLORS[config.providerId] ?? 'bg-gray-600'
              )}
            >
              {providerName.charAt(0)}
            </div>
          )}
          <div>
            <div className='flex items-center gap-1.5'>
              <h3 className='font-semibold text-gray-900 text-sm'>{config.displayName}</h3>
              {PROVIDER_DEFINITIONS[config.providerId]?.category === 'coding' && (
                <span className='inline-flex items-center rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-700 text-[10px]'>
                  {t('connections.codingBadge')}
                </span>
              )}
            </div>
            <p className='text-gray-500 text-xs'>{providerName}</p>
          </div>
        </div>

        {isAdmin && (
          <div className='relative'>
            <Button
              variant='ghost'
              size='icon'
              className='h-8 w-8'
              onClick={() => setShowActions(!showActions)}
            >
              <MoreVertical className='h-4 w-4' />
            </Button>
            {showActions && (
              <>
                <div className='fixed inset-0 z-10' onClick={() => setShowActions(false)} />
                <div className='absolute right-0 z-20 mt-1 w-32 rounded-lg border border-gray-200 bg-white py-1 shadow-lg'>
                  <button
                    onClick={() => {
                      setShowActions(false)
                      onEdit(config)
                    }}
                    className='flex w-full items-center gap-2 px-3 py-2 text-gray-700 text-sm hover:bg-gray-50'
                  >
                    <Pencil className='h-3.5 w-3.5' />
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => {
                      setShowActions(false)
                      onDelete(config.id)
                    }}
                    className='flex w-full items-center gap-2 px-3 py-2 text-red-600 text-sm hover:bg-red-50'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                    {t('common.delete')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className='mb-3 flex flex-wrap items-center gap-2'>
        <StatusBadge isActive={config.isActive} lastTestResult={config.lastTestResult} />
        <span className='text-gray-400 text-xs'>·</span>
        <span className='text-gray-500 text-xs'>
          {t('connections.modelCount', { count: modelCount })}
        </span>
        {config.modelName && (
          <>
            <span className='text-gray-400 text-xs'>·</span>
            <span className='font-mono text-gray-500 text-xs'>{config.modelName}</span>
          </>
        )}
      </div>

      {config.lastTestedAt && (
        <p className='mb-3 text-gray-400 text-xs'>
          {t('connections.lastTested', { date: new Date(config.lastTestedAt).toLocaleString() })}
          {config.lastTestLatencyMs !== null && ` · ${config.lastTestLatencyMs}ms`}
        </p>
      )}

      {testResult && testResult.message !== t('connections.testingMessage') && (
        <div
          className={cn(
            'mb-3 rounded-lg px-3 py-2 text-xs',
            testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          )}
        >
          {testResult.success ? (
            <CheckCircle2 className='mr-1 inline h-3.5 w-3.5' />
          ) : (
            <XCircle className='mr-1 inline h-3.5 w-3.5' />
          )}
          {testResult.message}
          {testResult.latencyMs > 0 && ` · ${testResult.latencyMs}ms`}
          {testResult.responsePreview && (
            <span className='ml-2 opacity-75'>— {testResult.responsePreview.slice(0, 80)}</span>
          )}
        </div>
      )}

      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={isTesting}
            onClick={() => onTest(config.id)}
          >
            {isTesting ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <RefreshCw className='h-3.5 w-3.5' />
            )}
            {t('connections.testConnection')}
          </Button>
          <Button variant='outline' size='sm' onClick={() => onChat(config)}>
            <MessageSquare className='h-3.5 w-3.5' />
            {t('connections.chat')}
          </Button>
        </div>
        {isAdmin && (
          <Switch checked={config.isActive} onCheckedChange={() => onToggleActive(config)} />
        )}
      </div>
    </div>
  )
}

function StatusBadge({
  isActive,
  lastTestResult,
}: {
  isActive: boolean
  lastTestResult: string | null
}) {
  const { t } = useTranslation()
  if (!isActive) {
    return (
      <span className='inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-gray-500 text-xs'>
        {t('common.disabled')}
      </span>
    )
  }
  if (
    lastTestResult &&
    (lastTestResult.includes('成功') || lastTestResult.toLowerCase().includes('success'))
  ) {
    return (
      <span className='inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 font-medium text-green-700 text-xs'>
        {t('common.enabled')}
      </span>
    )
  }
  if (
    lastTestResult &&
    (lastTestResult.includes('失败') || lastTestResult.toLowerCase().includes('fail'))
  ) {
    return (
      <span className='inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700 text-xs'>
        {t('connections.testFailed')}
      </span>
    )
  }
  return (
    <span className='inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700 text-xs'>
      {t('common.enabled')}
    </span>
  )
}
