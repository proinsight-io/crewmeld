'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Loader2, Wrench } from 'lucide-react'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'

interface ToolInstance {
  id: string
  name: string
  templateName: string
  description: string | null
}

interface Step3BindToolsProps {
  selectedInstanceIds: string[]
  onSelectionChange: (ids: string[]) => void
}

const CARD_COLORS = [
  { bg: 'bg-blue-100', text: 'text-blue-600' },
  { bg: 'bg-purple-100', text: 'text-purple-600' },
  { bg: 'bg-emerald-100', text: 'text-emerald-600' },
  { bg: 'bg-orange-100', text: 'text-orange-600' },
  { bg: 'bg-rose-100', text: 'text-rose-600' },
  { bg: 'bg-cyan-100', text: 'text-cyan-600' },
]

function getColor(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return CARD_COLORS[Math.abs(hash) % CARD_COLORS.length]
}

const PAGE_SIZE = 9

export function Step3BindTools({ selectedInstanceIds, onSelectionChange }: Step3BindToolsProps) {
  const { t } = useTranslation()
  const [instances, setInstances] = useState<ToolInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/employee/skills/bindable')
      if (!res.ok) return
      const json = await res.json()
      const items = (json.instances ?? []) as Array<{
        id: string
        name: string
        templateName: string
        description: string | null
      }>
      setInstances(
        items.map((i) => ({
          id: i.id,
          name: i.name,
          templateName: i.templateName || t('employees.unknownTool'),
          description: i.description,
        }))
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchInstances()
  }, [fetchInstances])

  const totalPages = Math.max(1, Math.ceil(instances.length / PAGE_SIZE))
  const pagedInstances = instances.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const toggle = (id: string) => {
    onSelectionChange(
      selectedInstanceIds.includes(id)
        ? selectedInstanceIds.filter((i) => i !== id)
        : [...selectedInstanceIds, id]
    )
  }

  return (
    <div>
      <h2 className='mb-2 font-semibold text-gray-900 text-lg'>{t('employees.step3Title')}</h2>
      <p className='mb-6 text-gray-500 text-sm'>{t('employees.step3Subtitle')}</p>

      {loading ? (
        <div className='flex items-center justify-center py-16'>
          <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
        </div>
      ) : instances.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-xl border-2 border-gray-200 border-dashed py-16 text-center'>
          <Wrench className='mb-3 h-10 w-10 text-gray-200' />
          <p className='font-medium text-gray-500 text-sm'>{t('employees.noToolInstances')}</p>
          <p className='mt-1 text-gray-400 text-xs'>{t('employees.noToolInstancesHint')}</p>
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
            {pagedInstances.map((inst) => {
              const selected = selectedInstanceIds.includes(inst.id)
              const color = getColor(inst.templateName)
              return (
                <button
                  key={inst.id}
                  type='button'
                  onClick={() => toggle(inst.id)}
                  className={cn(
                    'relative flex flex-col rounded-xl border p-4 text-left transition-all',
                    selected
                      ? 'border-blue-500 bg-blue-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                  )}
                >
                  {/* Selected badge */}
                  {selected && (
                    <span className='absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500'>
                      <Check className='h-3 w-3 text-white' strokeWidth={3} />
                    </span>
                  )}

                  {/* Icon */}
                  <div
                    className={cn(
                      'mb-3 flex h-10 w-10 items-center justify-center rounded-lg font-bold text-base',
                      color.bg,
                      color.text
                    )}
                  >
                    {inst.templateName.charAt(0)}
                  </div>

                  {/* Name */}
                  <p className='font-semibold text-gray-900 text-sm leading-snug'>{inst.name}</p>

                  {/* Description */}
                  {inst.description ? (
                    <p className='mt-1 line-clamp-2 text-gray-400 text-xs leading-relaxed'>
                      {inst.description}
                    </p>
                  ) : (
                    <p className='mt-1 text-gray-300 text-xs'>
                      {t('employees.toolSource', { name: inst.templateName })}
                    </p>
                  )}
                </button>
              )
            })}
          </div>

          <div className='mt-4 flex items-center justify-between'>
            {selectedInstanceIds.length > 0 ? (
              <p className='text-blue-600 text-xs'>
                {t('employees.toolSelectedCount', { count: selectedInstanceIds.length })}
              </p>
            ) : (
              <span />
            )}

            {totalPages > 1 && (
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className='flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40'
                >
                  <ChevronLeft className='h-4 w-4' />
                </button>
                <span className='text-gray-500 text-sm'>
                  {currentPage} / {totalPages}
                </span>
                <button
                  type='button'
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className='flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40'
                >
                  <ChevronRight className='h-4 w-4' />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
