'use client'

import { useMemo } from 'react'
import type { SopExecutionStatus } from '@crewmeld/db/schema'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { SupportedLocale } from '@/lib/core/utils/formatting'
import { formatDurationFromRange, formatRelativeTimeI18n } from '@/lib/core/utils/formatting'
import { useTranslation } from '@/hooks/use-translation'
import type { SopExecutionListItem } from '../types'

interface TaskTableProps {
  items: SopExecutionListItem[]
  isLoading: boolean
  error: string | null
  onRowClick: (item: SopExecutionListItem) => void
  pagination: { page: number; pageSize: number; total: number; totalPages: number } | null
  onPageChange: (page: number) => void
  showAutoRefreshIndicator: boolean
  onRetry?: () => void
}

export function TaskTable({
  items,
  isLoading,
  error,
  onRowClick,
  pagination,
  onPageChange,
  showAutoRefreshIndicator,
  onRetry,
}: TaskTableProps) {
  const { t, locale } = useTranslation()

  const STATUS_CONFIG = useMemo<
    Record<
      SopExecutionStatus,
      { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
    >
  >(
    () => ({
      pending: { label: t('tasks.statusPending'), variant: 'secondary' },
      running: { label: t('tasks.statusRunning'), variant: 'default' },
      paused_for_human: { label: t('tasks.statusHitlWaiting'), variant: 'secondary' },
      // Suspended waiting on an async tool — surface as "running" since the task
      // is still in progress from the operator's perspective.
      paused_for_tool: { label: t('tasks.statusRunning'), variant: 'default' },
      completed: { label: t('tasks.statusCompleted'), variant: 'outline' },
      timed_out: { label: t('tasks.statusTimeout'), variant: 'destructive' },
      error: { label: t('tasks.statusError'), variant: 'destructive' },
      failed: { label: t('tasks.statusFailed'), variant: 'destructive' },
      cancelled: { label: t('tasks.statusCancelled'), variant: 'secondary' },
    }),
    [t]
  )

  if (error) {
    return (
      <div className='flex h-64 flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50'>
        <p className='text-red-600 text-sm'>{t('tasks.loadFailedRetry')}</p>
        {onRetry && (
          <Button variant='outline' size='sm' className='mt-3' onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    )
  }

  if (isLoading && items.length === 0) {
    return (
      <div className='overflow-hidden rounded-xl border border-gray-200 bg-white'>
        <div className='space-y-0'>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className='flex gap-4 border-gray-100 border-b px-4 py-3'>
              <div className='h-5 w-24 animate-pulse rounded bg-gray-200' />
              <div className='h-5 flex-1 animate-pulse rounded bg-gray-200' />
              <div className='h-5 w-16 animate-pulse rounded bg-gray-200' />
              <div className='h-5 w-20 animate-pulse rounded bg-gray-200' />
              <div className='h-5 w-24 animate-pulse rounded bg-gray-200' />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className='flex h-64 items-center justify-center rounded-xl border border-gray-300 border-dashed bg-white'>
        <p className='text-gray-400 text-sm'>{t('tasks.noRecords')}</p>
      </div>
    )
  }

  return (
    <div className='overflow-hidden rounded-xl border border-gray-200 bg-white'>
      {showAutoRefreshIndicator && (
        <div className='flex items-center gap-2 border-gray-100 border-b px-4 py-2 text-gray-400 text-xs'>
          <span className='inline-block h-2 w-2 animate-pulse rounded-full bg-green-500' />
          {t('tasks.autoRefreshing')}
        </div>
      )}

      <div className='overflow-x-auto'>
        <table className='w-full min-w-[750px]'>
          <thead>
            <tr className='border-gray-200 border-b bg-gray-50'>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colSopName')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colStatus')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colNodeProgress')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colCurrentNode')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colTrigger')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colDuration')}
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-500 text-xs uppercase'>
                {t('tasks.colTime')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const statusCfg = STATUS_CONFIG[item.status] ?? {
                label: item.status,
                variant: 'secondary' as const,
              }
              return (
                <tr
                  key={item.id}
                  onClick={() => onRowClick(item)}
                  className='cursor-pointer border-gray-100 border-b transition-colors hover:bg-blue-50'
                >
                  <td className='whitespace-nowrap px-4 py-3 font-medium text-gray-900 text-sm'>
                    {item.sopName}
                    <span className='ml-1 text-gray-400 text-xs'>v{item.sopVersion}</span>
                  </td>
                  <td className='whitespace-nowrap px-4 py-3'>
                    <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
                  </td>
                  <td className='whitespace-nowrap px-4 py-3 text-gray-500 text-sm'>
                    {item.totalNodes > 0 ? (
                      <span>
                        <span className='font-medium text-gray-700'>{item.completedNodes}</span>
                        <span className='text-gray-400'>/{item.totalNodes}</span>
                      </span>
                    ) : (
                      <span className='text-gray-400'>—</span>
                    )}
                  </td>
                  <td className='max-w-[160px] truncate px-4 py-3 text-gray-600 text-sm'>
                    {item.currentNodeName ?? '—'}
                  </td>
                  <td className='whitespace-nowrap px-4 py-3 text-gray-500 text-sm'>
                    {item.triggeredByName}
                  </td>
                  <td className='whitespace-nowrap px-4 py-3 text-gray-500 text-sm'>
                    {formatDurationFromRange(item.startedAt, item.completedAt)}
                  </td>
                  <td className='whitespace-nowrap px-4 py-3 text-gray-400 text-sm'>
                    {formatRelativeTimeI18n(
                      item.startedAt ?? item.createdAt,
                      locale as SupportedLocale
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className='flex items-center justify-between border-gray-200 border-t px-4 py-3'>
          <span className='text-gray-500 text-sm'>
            {t('tasks.paginationTotal', {
              total: pagination.total,
              page: pagination.page,
              totalPages: pagination.totalPages,
            })}
          </span>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
              disabled={pagination.page <= 1}
            >
              <ChevronLeft className='h-4 w-4' />
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => onPageChange(Math.min(pagination.totalPages, pagination.page + 1))}
              disabled={pagination.page >= pagination.totalPages}
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
