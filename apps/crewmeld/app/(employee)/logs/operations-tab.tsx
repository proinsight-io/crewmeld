'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupportedLocale } from '@/lib/core/utils/formatting'
import { formatDateTimeI18n } from '@/lib/core/utils/formatting'
import { translateAuditDescription } from '@/lib/i18n/translate-audit-description'
import type { AuditLogItem } from '@/app/api/audit/types'
import { useTranslation } from '@/hooks/use-translation'
import { LogDetailDrawer } from './log-detail-drawer'
import { useActionLabels, useResourceTypeLabels } from './use-log-labels'

const PAGE_SIZE = 10

export function OperationsTab() {
  const { t, locale } = useTranslation()
  const pageSize = PAGE_SIZE
  const [logs, setLogs] = useState<AuditLogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)

  const [actionFilter, setActionFilter] = useState('')
  const [resourceTypeFilter, setResourceTypeFilter] = useState('')
  const [timeRange, setTimeRange] = useState('7')
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')

  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null)

  const ACTION_LABELS = useActionLabels()

  const ACTION_TYPE_OPTIONS = useMemo(
    () => [
      { value: '', label: t('logs.filterAllModules') },
      { value: 'employee', label: t('logs.filterEmployee') },
      { value: 'task', label: t('logs.filterTask') },
      { value: 'conversation', label: t('logs.filterConversation') },
      { value: 'knowledge', label: t('logs.filterKnowledge') },
      { value: 'connector', label: t('logs.filterConnector') },
      { value: 'channel', label: t('logs.filterChannel') },
      { value: 'human_employee', label: t('logs.filterHumanEmployee') },
      { value: 'sop', label: t('logs.filterSop') },
      { value: 'skill,tool', label: t('logs.filterSkillTool') },
      { value: 'system_config,model_config,user_management', label: t('logs.filterSystem') },
    ],
    [t]
  )

  const RESOURCE_TYPE_OPTIONS = useMemo(
    () => [
      { value: '', label: t('logs.filterAllResources') },
      { value: 'employee', label: t('logs.filterEmployee') },
      { value: 'task,scheduled_task', label: t('logs.filterTask') },
      { value: 'conversation', label: t('logs.filterConversation') },
      { value: 'knowledge', label: t('logs.filterKnowledge') },
      { value: 'connector', label: t('logs.filterConnector') },
      { value: 'channel', label: t('logs.filterChannel') },
      { value: 'human_employee', label: t('logs.filterHumanEmployee') },
      { value: 'sop', label: t('logs.filterSop') },
      { value: 'skill,tool', label: t('logs.filterSkillTool') },
      { value: 'system_config,model_config,user_management', label: t('logs.filterSystem') },
    ],
    [t]
  )

  const RESOURCE_TYPE_LABELS = useResourceTypeLabels()

  const TIME_RANGE_OPTIONS = useMemo(
    () => [
      { value: '1', label: t('logs.timeLast24h') },
      { value: '7', label: t('logs.timeLast7d') },
      { value: '30', label: t('logs.timeLast30d') },
    ],
    [t]
  )

  /**
   * Dynamically generate i18n description from action + resourceName,
   * no longer relying on Chinese descriptions stored in the database.
   */
  const humanizeDescription = useCallback(
    (log: AuditLogItem): string => {
      const actionLabel = ACTION_LABELS[log.action]
      if (!actionLabel) {
        return translateAuditDescription(log.description ?? log.action ?? '', log.metadata, t)
      }
      if (log.resourceName) {
        return t('logs.descriptionWithName', { action: actionLabel, name: log.resourceName })
      }
      return t('logs.descriptionNoName', { action: actionLabel })
    },
    [ACTION_LABELS, t]
  )

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300)
    return () => clearTimeout(timer)
  }, [keyword])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(pageSize))
      params.set('offset', String(offset))

      if (actionFilter) {
        params.set('action', actionFilter)
      }
      if (resourceTypeFilter) {
        params.set('resourceType', resourceTypeFilter)
      }
      if (debouncedKeyword) {
        params.set('keyword', debouncedKeyword)
      }

      const now = new Date()
      const start = new Date(now)
      start.setDate(start.getDate() - Number(timeRange))
      params.set('startDate', start.toISOString())
      params.set('endDate', now.toISOString())

      const res = await fetch(`/api/audit/logs?${params.toString()}`)
      const json = await res.json()

      if (!json.success) {
        setError(json.error ?? t('logs.loadFailed'))
        return
      }

      setLogs(json.data)
      setTotal(json.pagination.total)
    } catch {
      setError(t('logs.loadFailedRetry'))
    } finally {
      setLoading(false)
    }
  }, [offset, pageSize, actionFilter, resourceTypeFilter, timeRange, debouncedKeyword, t])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  const handleFilterChange = useCallback(() => {
    setOffset(0)
  }, [])

  useEffect(() => {
    handleFilterChange()
  }, [actionFilter, resourceTypeFilter, timeRange, debouncedKeyword, handleFilterChange])

  const totalPages = Math.ceil(total / pageSize)
  const currentPage = Math.floor(offset / pageSize) + 1

  const hasActiveFilters = actionFilter || resourceTypeFilter || debouncedKeyword

  return (
    <div className='space-y-4'>
      {/* Filter bar */}
      <div className='rounded-xl border border-gray-200 bg-white p-4'>
        <div className='flex flex-wrap items-center gap-3'>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className='h-9 rounded-lg border border-gray-200 bg-gray-50 px-3 text-gray-700 text-sm transition-colors hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
          >
            {ACTION_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            value={resourceTypeFilter}
            onChange={(e) => setResourceTypeFilter(e.target.value)}
            className='h-9 rounded-lg border border-gray-200 bg-gray-50 px-3 text-gray-700 text-sm transition-colors hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
          >
            {RESOURCE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className='h-9 rounded-lg border border-gray-200 bg-gray-50 px-3 text-gray-700 text-sm transition-colors hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className='relative flex-1'>
            <input
              type='text'
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('logs.searchPlaceholder')}
              className='h-9 w-full min-w-[180px] rounded-lg border border-gray-200 bg-gray-50 pr-8 pl-3 text-sm transition-colors placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500'
            />
            {keyword && (
              <button
                type='button'
                onClick={() => setKeyword('')}
                className='-translate-y-1/2 absolute top-1/2 right-2.5 text-gray-400 hover:text-gray-600'
              >
                &times;
              </button>
            )}
          </div>

          {hasActiveFilters && (
            <button
              type='button'
              onClick={() => {
                setActionFilter('')
                setResourceTypeFilter('')
                setKeyword('')
              }}
              className='h-9 rounded-lg px-3 text-gray-500 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700'
            >
              {t('logs.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className='flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3'>
          <span className='text-red-700 text-sm'>{error}</span>
          <button
            type='button'
            onClick={fetchLogs}
            className='font-medium text-red-800 text-sm hover:underline'
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className='overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm'>
        <table className='w-full table-fixed'>
          <thead>
            <tr className='border-gray-100 border-b bg-gray-50/80'>
              <th className='w-[145px] px-4 py-3 text-left font-semibold text-gray-500 text-xs'>
                {t('logs.tableHeaderTime')}
              </th>
              <th className='w-[90px] px-4 py-3 text-left font-semibold text-gray-500 text-xs'>
                {t('logs.tableHeaderOperator')}
              </th>
              <th className='w-[130px] px-4 py-3 text-left font-semibold text-gray-500 text-xs'>
                {t('logs.tableHeaderAction')}
              </th>
              <th className='w-[150px] px-4 py-3 text-left font-semibold text-gray-500 text-xs'>
                {t('logs.tableHeaderResource')}
              </th>
              <th className='w-[200px] px-4 py-3 text-left font-semibold text-gray-500 text-xs'>
                {t('logs.tableHeaderDescription')}
              </th>
            </tr>
          </thead>
          <tbody className='divide-y divide-gray-50'>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className='px-4 py-3.5'>
                      <div
                        className='h-4 animate-pulse rounded-md bg-gray-100'
                        // Deterministic width derived from the row/column index so
                        // the server and client render identical markup — a
                        // render-time Math.random() here produced different widths
                        // on each side and tripped a React hydration mismatch.
                        style={{ width: `${60 + (((i * 5 + j) * 13) % 30)}%` }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={5} className='px-4 py-16 text-center'>
                  <div className='text-4xl text-gray-300'>📋</div>
                  <p className='mt-3 text-gray-400 text-sm'>
                    {hasActiveFilters ? t('logs.noMatchRecords') : t('logs.noRecords')}
                  </p>
                  {hasActiveFilters && (
                    <button
                      type='button'
                      onClick={() => {
                        setActionFilter('')
                        setResourceTypeFilter('')
                        setKeyword('')
                      }}
                      className='mt-2 text-blue-500 text-sm hover:underline'
                    >
                      {t('logs.clearFilterConditions')}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const actorI18nKey =
                  typeof log.metadata?.actorI18nKey === 'string' ? log.metadata.actorI18nKey : null
                const actorDisplay =
                  log.actorName ??
                  (actorI18nKey ? t(`auditLog.${actorI18nKey}`) : null) ??
                  t('logs.systemActor')
                return (
                  <tr
                    key={log.id}
                    onClick={() => setSelectedLog(log)}
                    className='cursor-pointer transition-colors hover:bg-blue-50/40'
                  >
                    <td className='px-4 py-3 text-gray-500 text-xs tabular-nums'>
                      {formatDateTimeI18n(log.createdAt, locale as SupportedLocale)}
                    </td>
                    <td className='px-4 py-3'>
                      <span className='inline-flex items-center gap-1.5 text-gray-800 text-sm'>
                        <span className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 font-medium text-[10px] text-gray-500'>
                          {actorDisplay[0]}
                        </span>
                        <span className='truncate'>{actorDisplay}</span>
                      </span>
                    </td>
                    <td className='px-4 py-3'>
                      <span className='inline-block rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700 text-xs'>
                        {ACTION_LABELS[log.action] ??
                          translateAuditDescription(
                            log.description ?? log.action ?? '',
                            log.metadata,
                            t
                          ) ??
                          log.action}
                      </span>
                    </td>
                    <td className='px-4 py-3 text-gray-800 text-sm'>
                      <div className='truncate font-medium'>
                        {log.resourceName ??
                          RESOURCE_TYPE_LABELS[log.resourceType] ??
                          log.resourceType}
                      </div>
                      <div className='truncate text-gray-400 text-xs'>
                        {RESOURCE_TYPE_LABELS[log.resourceType] ?? log.resourceType}
                      </div>
                    </td>
                    <td
                      className='truncate px-4 py-3 text-gray-500 text-sm'
                      title={humanizeDescription(log)}
                    >
                      {humanizeDescription(log)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className='flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3'>
          <span className='text-gray-500 text-sm'>
            {t('logs.paginationTotal', {
              total: String(total),
              page: String(currentPage),
              totalPages: String(totalPages),
            })}
          </span>
          <div className='flex gap-2'>
            <button
              type='button'
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
              className='h-8 rounded-lg border border-gray-200 px-3 text-gray-600 text-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40'
            >
              {t('logs.prevPage')}
            </button>
            <button
              type='button'
              disabled={offset + pageSize >= total}
              onClick={() => setOffset(offset + pageSize)}
              className='h-8 rounded-lg border border-gray-200 px-3 text-gray-600 text-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40'
            >
              {t('logs.nextPage')}
            </button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      <LogDetailDrawer
        log={selectedLog}
        open={selectedLog !== null}
        onClose={() => setSelectedLog(null)}
      />
    </div>
  )
}
