'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Brain, Info, Loader2, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/use-translation'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

interface ModelConfigItem {
  id: string
  providerId: string
  displayName: string
  modelName: string | null
  isActive: boolean
  providerName: string
}

interface Step5BindModelProps {
  selectedModelId: string | null
  onSelectModel: (modelId: string | null) => void
}

export function Step5BindModel({ selectedModelId, onSelectModel }: Step5BindModelProps) {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelConfigItem[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/employee/models?activeOnly=true')
      const json = await res.json()
      if (json.success) {
        const items: ModelConfigItem[] = json.data.configs.map(
          (c: {
            id: string
            providerId: string
            displayName: string
            modelName: string | null
            isActive: boolean
            providerMeta: { name: string }
          }) => ({
            id: c.id,
            providerId: c.providerId,
            displayName: c.displayName,
            modelName: c.modelName,
            isActive: c.isActive,
            providerName: c.providerMeta.name,
          })
        )
        setModels(items)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models
    const keyword = searchQuery.trim().toLowerCase()
    return models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(keyword) ||
        m.providerName.toLowerCase().includes(keyword) ||
        m.modelName?.toLowerCase().includes(keyword)
    )
  }, [models, searchQuery])

  const getProviderIcon = (providerId: string) => {
    const provider = PROVIDER_DEFINITIONS[providerId]
    return provider?.icon ?? null
  }

  return (
    <div>
      <h2 className='mb-2 font-semibold text-gray-900 text-lg'>{t('employees.bindModelTitle')}</h2>
      <p className='mb-6 text-gray-500 text-sm'>{t('employees.bindModelDescription')}</p>

      <div className='mx-auto max-w-lg'>
        {loading ? (
          <div className='flex h-48 flex-col items-center justify-center rounded-xl border border-gray-300 border-dashed'>
            <Loader2 className='mb-2 h-8 w-8 animate-spin text-gray-300' />
            <p className='text-gray-400 text-sm'>{t('employees.bindModelLoading')}</p>
          </div>
        ) : models.length === 0 ? (
          <div className='flex h-48 flex-col items-center justify-center rounded-xl border-2 border-gray-300 border-dashed bg-gray-50'>
            <Brain className='mb-3 h-10 w-10 text-gray-300' />
            <p className='font-medium text-gray-500 text-sm'>{t('employees.bindModelNoModels')}</p>
            <p className='mt-1 text-gray-400 text-xs'>{t('employees.bindModelConfigureHint')}</p>
          </div>
        ) : (
          <div className='space-y-4'>
            {/* Search box */}
            <div className='relative'>
              <Search className='-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-gray-400' />
              <Input
                data-testid='employee-form:input:model-search'
                placeholder={t('employees.bindModelSearchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className='pr-8 pl-9'
              />
              {searchQuery && (
                <button
                  className='-translate-y-1/2 absolute top-1/2 right-3 text-gray-400 hover:text-gray-600'
                  onClick={() => setSearchQuery('')}
                >
                  <X className='h-4 w-4' />
                </button>
              )}
            </div>

            {/* Model list */}
            <div className='max-h-80 space-y-3 overflow-y-auto'>
              {filteredModels.length === 0 ? (
                <div className='py-8 text-center'>
                  <p className='text-gray-500 text-sm'>{t('employees.bindModelNoMatch')}</p>
                </div>
              ) : (
                filteredModels.map((model) => {
                  const isSelected = selectedModelId === model.id
                  const ProviderIcon = getProviderIcon(model.providerId)
                  return (
                    <button
                      key={model.id}
                      data-testid={`employee-form:select:model:${model.id}`}
                      onClick={() => onSelectModel(isSelected ? null : model.id)}
                      className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                        isSelected
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-50'>
                        {ProviderIcon ? (
                          <ProviderIcon className='h-5 w-5 text-purple-600' />
                        ) : (
                          <Brain className='h-5 w-5 text-purple-600' />
                        )}
                      </div>
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-1.5'>
                          <p className='font-medium text-gray-900 text-sm'>{model.displayName}</p>
                          {PROVIDER_DEFINITIONS[model.providerId]?.category === 'coding' && (
                            <span className='inline-flex items-center rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-700 text-[10px]'>
                              {t('connections.codingBadge')}
                            </span>
                          )}
                        </div>
                        <div className='mt-0.5 flex items-center gap-2 text-gray-500 text-xs'>
                          <span>{model.providerName}</span>
                          {model.modelName && (
                            <>
                              <span>·</span>
                              <span className='font-mono'>{model.modelName}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className='shrink-0'>
                        <div
                          className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                            isSelected ? 'border-blue-600 bg-blue-600' : 'border-gray-300'
                          }`}
                        >
                          {isSelected && (
                            <svg className='h-3 w-3 text-white' viewBox='0 0 14 14' fill='none'>
                              <path
                                d='M11.6667 3.5L5.25 9.91667L2.33333 7'
                                stroke='currentColor'
                                strokeWidth='2'
                                strokeLinecap='round'
                                strokeLinejoin='round'
                              />
                            </svg>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}

        <div className='mt-4 rounded-lg border border-blue-100 bg-blue-50 p-4'>
          <div className='flex items-start gap-2'>
            <Info className='mt-0.5 h-4 w-4 shrink-0 text-blue-600' />
            <div>
              <p className='font-medium text-blue-800 text-sm'>
                {t('employees.bindModelCanContinue')}
              </p>
              <p className='mt-0.5 text-blue-600 text-xs'>{t('employees.bindModelOptionalHint')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
