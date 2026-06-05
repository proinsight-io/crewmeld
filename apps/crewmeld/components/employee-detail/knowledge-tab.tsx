'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  Database,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import Link from 'next/link'
import type { RagflowDataset } from '@/lib/ragflow/types'
import { useTranslation } from '@/hooks/use-translation'

interface KnowledgeTabProps {
  employeeId: string
  ragflowDatasetIds?: string[]
  onUpdate?: () => void
}

/** Error kind: not configured vs connection error */
type ErrorKind = 'not_configured' | 'connection_error'

export function KnowledgeTab({ employeeId, ragflowDatasetIds = [], onUpdate }: KnowledgeTabProps) {
  const { t } = useTranslation()
  const [allDatasets, setAllDatasets] = useState<RagflowDataset[]>([])
  const [loading, setLoading] = useState(true)
  const [ragflowAvailable, setRagflowAvailable] = useState(false)
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const fetchDatasets = useCallback(async () => {
    setLoading(true)
    setErrorKind(null)
    try {
      const res = await fetch('/api/employee/ragflow/datasets')
      const json = await res.json()
      if (res.ok && json.success && Array.isArray(json.data)) {
        setRagflowAvailable(true)
        setAllDatasets(json.data)
        setErrorKind(null)
      } else {
        setRagflowAvailable(false)
        setAllDatasets([])
        setErrorKind(json?.code === 'CONFIG_MISSING' ? 'not_configured' : 'connection_error')
      }
    } catch {
      setRagflowAvailable(false)
      setAllDatasets([])
      setErrorKind('connection_error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDatasets()
  }, [fetchDatasets])

  const boundDatasets = allDatasets.filter((ds) => ragflowDatasetIds.includes(ds.id))
  const availableDatasets = allDatasets.filter((ds) => !ragflowDatasetIds.includes(ds.id))
  // IDs the employee config still references but RagFlow no longer has
  // (dataset was deleted directly in RagFlow / via another path). Surface
  // them so the user can clean up the stale binding from the UI — otherwise
  // they sit forever and break KB retrieval with "you don't own the dataset".
  const deadBindingIds = ragflowDatasetIds.filter(
    (id) => !allDatasets.some((ds) => ds.id === id)
  )

  const saveBinding = async (newIds: string[]) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/employee/employees/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ragflowDatasetIds: newIds }),
      })
      if (res.ok) {
        onUpdate?.()
      }
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleBind = async (datasetId: string) => {
    const newIds = [...ragflowDatasetIds, datasetId]
    await saveBinding(newIds)
    setShowPicker(false)
  }

  const handleUnbind = async (datasetId: string) => {
    setRemovingId(datasetId)
    const newIds = ragflowDatasetIds.filter((id) => id !== datasetId)
    await saveBinding(newIds)
    setRemovingId(null)
  }

  if (loading) {
    return (
      <div className='flex h-48 flex-col items-center justify-center'>
        <Loader2 className='h-8 w-8 animate-spin text-gray-300' />
        <p className='mt-3 text-gray-400 text-sm'>{t('employees.knowledgeLoading')}</p>
      </div>
    )
  }

  if (!ragflowAvailable && errorKind === 'not_configured') {
    return (
      <div className='flex flex-col items-center justify-center rounded-2xl border border-gray-200 border-dashed bg-gradient-to-b from-gray-50/50 to-white px-6 py-14 text-center'>
        <div className='relative mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-blue-50 to-indigo-50 ring-1 ring-blue-100/60'>
          <BookOpen className='h-7 w-7 text-blue-500' />
          <span className='-right-0.5 -bottom-0.5 absolute flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-amber-400 shadow-sm'>
            <Settings className='h-3 w-3 text-white' />
          </span>
        </div>
        <p className='font-semibold text-base text-gray-900'>
          {t('employees.knowledgeNotConfigured')}
        </p>
        <p className='mt-1.5 max-w-sm text-gray-500 text-sm'>
          {t('employees.knowledgeConfigureHint')}
        </p>
        <Link
          href='/connections?tab=ragflow'
          data-testid='knowledge-tab:empty:goto-settings'
          className='mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-sm text-white shadow-sm transition-colors hover:bg-blue-700'
        >
          <Settings className='h-4 w-4' />
          {t('employees.knowledgeGotoSettings')}
        </Link>
      </div>
    )
  }

  if (!ragflowAvailable && errorKind === 'connection_error') {
    return (
      <div className='flex flex-col items-center justify-center rounded-2xl border border-amber-200 border-dashed bg-gradient-to-b from-amber-50/60 to-white px-6 py-14 text-center'>
        <div className='relative mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-amber-50 to-orange-50 ring-1 ring-amber-100/80'>
          <Database className='h-7 w-7 text-amber-500' />
          <span className='-right-0.5 -bottom-0.5 absolute flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-amber-500 shadow-sm'>
            <AlertCircle className='h-3.5 w-3.5 text-white' />
          </span>
        </div>
        <p className='font-semibold text-base text-gray-900'>{t('knowledge.connectionError')}</p>
        <p className='mt-1.5 max-w-md text-gray-500 text-sm'>
          {t('knowledge.connectionErrorHint')}
        </p>
        <div className='mt-5 flex items-center gap-2'>
          <button
            type='button'
            onClick={fetchDatasets}
            className='inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium text-gray-700 text-sm shadow-sm transition-colors hover:bg-gray-50'
            data-testid='knowledge-tab:error:retry'
          >
            <RefreshCw className='h-3.5 w-3.5' />
            {t('common.retry')}
          </button>
          <Link
            href='/connections?tab=ragflow'
            data-testid='knowledge-tab:error:goto-settings'
            className='inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-sm text-white shadow-sm transition-colors hover:bg-blue-700'
          >
            <Settings className='h-3.5 w-3.5' />
            {t('knowledge.gotoConnectionErrorSettings')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Title bar */}
      <div className='mb-4 flex items-center justify-between'>
        <p className='font-medium text-gray-700 text-sm'>
          {t('employees.knowledgeBoundTitle')}
          {boundDatasets.length > 0 && (
            <span className='ml-1.5 text-gray-400 text-xs'>({boundDatasets.length})</span>
          )}
        </p>
        <button
          type='button'
          onClick={() => setShowPicker(true)}
          disabled={saving}
          className='flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white text-xs transition-colors hover:bg-blue-700 disabled:opacity-60'
          data-testid='knowledge-tab:btn:bind'
        >
          <Plus className='h-3.5 w-3.5' />
          {t('employees.knowledgeBind')}
        </button>
      </div>

      {/* Dead bindings (referenced but no longer in RagFlow) */}
      {deadBindingIds.length > 0 && (
        <div className='mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {deadBindingIds.map((id) => (
            <div
              key={id}
              className='group relative flex items-start gap-3 rounded-xl border border-red-200 border-dashed bg-red-50/40 p-4'
              data-testid={`knowledge-tab:dead-binding:${id}`}
            >
              <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100'>
                <AlertCircle className='h-4 w-4 text-red-500' />
              </div>
              <div className='min-w-0 flex-1 pr-8'>
                <p className='truncate font-medium text-red-700 text-sm'>
                  {t('employees.knowledgeDeadBinding')}
                </p>
                <p className='mt-0.5 line-clamp-1 text-red-400 text-xs'>
                  {t('employees.knowledgeDeadBindingHint')}
                </p>
                <p className='mt-1.5 truncate font-mono text-red-300 text-xs'>{id}</p>
              </div>
              <button
                type='button'
                onClick={() => handleUnbind(id)}
                disabled={removingId === id || saving}
                className='absolute top-3 right-3 rounded-md p-1 text-red-400 transition-all hover:bg-red-100 hover:text-red-600 disabled:opacity-50'
                title={t('employees.knowledgeCleanupDead')}
                data-testid={`knowledge-tab:cleanup-dead:${id}`}
              >
                {removingId === id ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Trash2 className='h-4 w-4' />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Bound list */}
      {boundDatasets.length === 0 && deadBindingIds.length === 0 ? (
        <div className='flex h-48 flex-col items-center justify-center rounded-xl border border-gray-200 border-dashed bg-white'>
          <BookOpen className='h-10 w-10 text-gray-200' />
          <p className='mt-3 text-gray-500 text-sm'>{t('employees.knowledgeEmpty')}</p>
          <p className='mt-1 text-gray-400 text-xs'>{t('employees.knowledgeEmptyHint')}</p>
        </div>
      ) : boundDatasets.length === 0 ? null : (
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {boundDatasets.map((ds) => (
            <div
              key={ds.id}
              className='group relative flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 transition-all hover:border-gray-300'
              data-testid={`knowledge-tab:binding:${ds.id}`}
            >
              <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50'>
                <BookOpen className='h-4 w-4 text-blue-500' />
              </div>
              <div className='min-w-0 flex-1 pr-8'>
                <p className='truncate font-medium text-gray-900 text-sm'>{ds.name}</p>
                {ds.description && (
                  <p className='mt-0.5 line-clamp-1 text-gray-400 text-xs'>{ds.description}</p>
                )}
                <div className='mt-1.5 flex items-center gap-3 text-gray-400 text-xs'>
                  <span className='flex items-center gap-1'>
                    <FileText className='h-3 w-3' />
                    {ds.document_count} {t('employees.documentsSuffix')}
                  </span>
                  <span>
                    {ds.chunk_count} {t('employees.chunksSuffix')}
                  </span>
                </div>
              </div>
              {/* Unbind button */}
              <button
                type='button'
                onClick={() => handleUnbind(ds.id)}
                disabled={removingId === ds.id || saving}
                className='absolute top-3 right-3 rounded-md p-1 text-gray-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 disabled:opacity-50 group-hover:opacity-100'
                title={t('employees.knowledgeUnbind')}
                data-testid={`knowledge-tab:unbind:${ds.id}`}
              >
                {removingId === ds.id ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Trash2 className='h-4 w-4' />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Picker dialog */}
      {showPicker && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40'>
          <div className='w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl'>
            <div className='mb-4 flex items-center justify-between'>
              <h3 className='font-semibold text-base text-gray-900'>
                {t('employees.knowledgePickerTitle')}
              </h3>
              <button
                type='button'
                onClick={() => setShowPicker(false)}
                className='rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                data-testid='knowledge-tab:picker:close'
              >
                <X className='h-5 w-5' />
              </button>
            </div>

            {availableDatasets.length === 0 ? (
              <div className='flex h-40 flex-col items-center justify-center'>
                <BookOpen className='h-8 w-8 text-gray-200' />
                <p className='mt-2 text-gray-500 text-sm'>{t('employees.knowledgeNoAvailable')}</p>
                <p className='mt-1 text-gray-400 text-xs'>{t('employees.knowledgeAllBound')}</p>
              </div>
            ) : (
              <div className='max-h-80 space-y-2 overflow-y-auto'>
                {availableDatasets.map((ds) => (
                  <div
                    key={ds.id}
                    className='flex items-center justify-between rounded-lg border border-gray-200 p-3 transition-all hover:border-blue-300 hover:bg-blue-50/50'
                    data-testid={`knowledge-tab:picker:${ds.id}`}
                  >
                    <div className='flex items-center gap-3'>
                      <div className='flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50'>
                        <BookOpen className='h-4 w-4 text-blue-500' />
                      </div>
                      <div>
                        <p className='font-medium text-gray-900 text-sm'>{ds.name}</p>
                        {ds.description && (
                          <p className='mt-0.5 text-gray-400 text-xs'>{ds.description}</p>
                        )}
                        <p className='mt-0.5 text-gray-400 text-xs'>
                          {ds.document_count} {t('employees.documentsSuffix')} · {ds.chunk_count}{' '}
                          {t('employees.chunksSuffix')}
                        </p>
                      </div>
                    </div>
                    <button
                      type='button'
                      onClick={() => handleBind(ds.id)}
                      disabled={saving}
                      className='rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white text-xs transition-colors hover:bg-blue-700 disabled:opacity-60'
                      data-testid={`knowledge-tab:picker:bind:${ds.id}`}
                    >
                      {saving ? (
                        <Loader2 className='h-3.5 w-3.5 animate-spin' />
                      ) : (
                        t('employees.knowledgeBindAction')
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
