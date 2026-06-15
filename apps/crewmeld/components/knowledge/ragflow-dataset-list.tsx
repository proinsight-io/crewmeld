'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Database,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { RagflowDataset } from '@/lib/ragflow/types'
import { PermissionGuard } from '@/app/(employee)/components/permission-guard'
import { useTranslation } from '@/hooks/use-translation'

function formatDate(value: string | number | undefined, locale: string): string {
  if (!value) return ''
  const num = typeof value === 'number' ? value : Number(value)
  let d: Date
  if (!Number.isNaN(num) && num > 0) {
    d = new Date(num < 1e12 ? num * 1000 : num)
  } else {
    d = new Date(value as string)
  }
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** Error kind: not configured vs connection error */
type ErrorKind = 'not_configured' | 'connection_error'

export function RagflowDatasetList() {
  const { t, locale } = useTranslation()
  const [datasets, setDatasets] = useState<RagflowDataset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<ErrorKind>('connection_error')
  const [searchTerm, setSearchTerm] = useState('')

  // Create / edit dialog state (shared form, distinguished by editTarget)
  const [showFormDialog, setShowFormDialog] = useState(false)
  const [editTarget, setEditTarget] = useState<{ id: string } | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchDatasets = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/employee/ragflow/datasets')
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error ?? t('knowledge.fetchDatasetsFailed'))
        setErrorKind(json.code === 'CONFIG_MISSING' ? 'not_configured' : 'connection_error')
        setDatasets([])
        return
      }
      setDatasets(json.data ?? [])
    } catch {
      setError(t('knowledge.cannotConnect'))
      setErrorKind('connection_error')
      setDatasets([])
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchDatasets()
  }, [fetchDatasets])

  function openCreateDialog() {
    setEditTarget(null)
    setFormName('')
    setFormDesc('')
    setFormError(null)
    setShowFormDialog(true)
  }

  function openEditDialog(ds: RagflowDataset) {
    setEditTarget({ id: ds.id })
    setFormName(ds.name)
    setFormDesc(ds.description ?? '')
    setFormError(null)
    setShowFormDialog(true)
  }

  async function handleSubmit() {
    if (!formName.trim()) return
    setSubmitting(true)
    setFormError(null)
    try {
      const isEdit = editTarget !== null
      const res = await fetch(
        isEdit
          ? `/api/employee/ragflow/datasets/${encodeURIComponent(editTarget.id)}`
          : '/api/employee/ragflow/datasets',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formName.trim(),
            description: formDesc.trim(),
          }),
        }
      )
      const json = await res.json()
      if (res.ok && json.success) {
        setShowFormDialog(false)
        setEditTarget(null)
        setFormName('')
        setFormDesc('')
        fetchDatasets()
      } else {
        setFormError(
          json.error ?? t(isEdit ? 'knowledge.updateFailed' : 'knowledge.createFailed')
        )
      }
    } catch {
      setFormError(t('common.networkError'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    // Capture early to avoid stale state in async closure
    const { id, name: _name } = deleteTarget
    setDeleting(true)
    try {
      const res = await fetch('/api/employee/ragflow/datasets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const json = await res.json()
      if (res.ok && json.success) {
        setDatasets((prev) => prev.filter((d) => d.id !== id))
        setDeleteTarget(null)
      } else {
        setError(json.error ?? t('knowledge.deleteFailed'))
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setDeleting(false)
    }
  }

  const filtered = datasets.filter((ds) => {
    if (!searchTerm) return true
    const term = searchTerm.toLowerCase()
    return (
      ds.name.toLowerCase().includes(term) || (ds.description ?? '').toLowerCase().includes(term)
    )
  })

  if (loading) {
    return (
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className='animate-pulse rounded-xl border border-gray-200 bg-white p-5'>
            <div className='mb-3 h-5 w-32 rounded bg-gray-200' />
            <div className='mb-4 h-4 w-48 rounded bg-gray-100' />
            <div className='h-4 w-full rounded bg-gray-100' />
          </div>
        ))}
      </div>
    )
  }

  /* ── Not configured state ── */
  if (error && errorKind === 'not_configured') {
    return (
      <div className='flex flex-col items-center justify-center rounded-2xl border border-gray-300 border-dashed bg-gradient-to-b from-gray-50/60 to-white px-6 py-14 text-center'>
        <div className='relative mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-gray-100 to-gray-50 ring-1 ring-gray-200/80'>
          <Database className='h-7 w-7 text-gray-400' />
        </div>
        <p className='font-semibold text-base text-gray-900'>{t('knowledge.notConfiguredTitle')}</p>
        <p className='mt-1.5 max-w-md text-gray-500 text-sm'>{t('knowledge.notConfiguredHint')}</p>
        <div className='mt-5'>
          <Link
            href='/connections?tab=ragflow'
            data-testid='knowledge:ragflow:not-configured:goto-settings'
            className='inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-sm text-white shadow-sm transition-colors hover:bg-blue-700'
          >
            <Settings className='h-3.5 w-3.5' />
            {t('knowledge.gotoConnectionSettings')}
          </Link>
        </div>
      </div>
    )
  }

  /* ── Connection error state ── */
  if (error && errorKind === 'connection_error') {
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
          <Button
            variant='outline'
            size='sm'
            onClick={fetchDatasets}
            data-testid='knowledge:ragflow:error:retry'
          >
            <RefreshCw className='h-3.5 w-3.5' />
            {t('common.retry')}
          </Button>
          <Link
            href='/connections?tab=ragflow'
            data-testid='knowledge:ragflow:error:goto-settings'
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
      {/* Toolbar */}
      <div className='mb-4 flex items-center gap-3'>
        <div className='relative flex-1'>
          <Search className='-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-gray-400' />
          <input
            type='text'
            placeholder={t('knowledge.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            data-testid='knowledge:ragflow:search'
            className='w-full rounded-lg border border-gray-200 bg-white py-2 pr-4 pl-10 text-gray-900 text-sm placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'
          />
        </div>
        <PermissionGuard requires='knowledge:create'>
          <Button
            onClick={openCreateDialog}
            data-testid='knowledge:ragflow:create'
          >
            <Plus className='h-4 w-4' />
            {t('knowledge.addKnowledge')}
          </Button>
        </PermissionGuard>
      </div>

      {datasets.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-xl border border-gray-300 border-dashed bg-white py-16'>
          <Database className='mb-4 h-12 w-12 text-gray-300' />
          <p className='mb-2 font-medium text-gray-700 text-lg'>{t('knowledge.emptyDatasets')}</p>
          <p className='mb-4 text-gray-500 text-sm'>{t('knowledge.emptyDatasetsHint')}</p>
          <PermissionGuard requires='knowledge:create'>
            <Button onClick={openCreateDialog}>
              <Plus className='h-4 w-4' />
              {t('knowledge.addKnowledge')}
            </Button>
          </PermissionGuard>
        </div>
      ) : filtered.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white py-12'>
          <Search className='mb-3 h-8 w-8 text-gray-300' />
          <p className='text-gray-500 text-sm'>{t('knowledge.noMatchDatasets')}</p>
        </div>
      ) : (
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
          {filtered.map((ds) => (
            <div
              key={ds.id}
              data-testid={`knowledge:ragflow:card:${ds.id}`}
              className='group relative rounded-xl border border-gray-200 bg-white p-5 transition-shadow hover:shadow-md'
            >
              <Link href={`/knowledge/datasets/${ds.id}`} className='block'>
                <h3 className='mb-1 font-semibold text-gray-900'>{ds.name}</h3>
                {ds.description && (
                  <p className='mb-3 line-clamp-2 text-gray-500 text-sm'>{ds.description}</p>
                )}
                {!ds.description && <div className='mb-3' />}
                <div className='flex items-center gap-4 text-gray-400 text-xs'>
                  <span className='flex items-center gap-1'>
                    <FileText className='h-3.5 w-3.5' />
                    {t('knowledge.documentCount', { count: ds.document_count })}
                  </span>
                  {ds.created_at && (
                    <span>
                      {t('knowledge.createdAt', { date: formatDate(ds.created_at, locale) })}
                    </span>
                  )}
                </div>
              </Link>
              <div className='absolute top-3 right-3 flex items-center gap-1'>
                <PermissionGuard requires='knowledge:edit'>
                  <button
                    type='button'
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      openEditDialog(ds)
                    }}
                    aria-label={t('knowledge.editDataset')}
                    title={t('knowledge.editDataset')}
                    data-testid={`knowledge:ragflow:edit:${ds.id}`}
                    className='rounded p-1 text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-500'
                  >
                    <Pencil className='h-4 w-4' />
                  </button>
                </PermissionGuard>
                <PermissionGuard requires='knowledge:delete'>
                  <button
                    type='button'
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDeleteTarget({ id: ds.id, name: ds.name })
                    }}
                    aria-label={t('knowledge.deleteDataset')}
                    title={t('knowledge.deleteDataset')}
                    data-testid={`knowledge:ragflow:delete:${ds.id}`}
                    className='rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500'
                  >
                    <Trash2 className='h-4 w-4' />
                  </button>
                </PermissionGuard>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / edit knowledge base dialog (shared form) */}
      <Dialog
        open={showFormDialog}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null)
            setFormName('')
            setFormDesc('')
            setFormError(null)
          }
          setShowFormDialog(open)
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>
              {editTarget
                ? t('knowledge.editDatasetTitle')
                : t('knowledge.addDatasetTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className='space-y-4 py-2'>
            {formError && (
              <div className='rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-600 text-xs'>
                {formError}
              </div>
            )}
            <div>
              <label
                htmlFor='ragflow-form-name'
                className='mb-1.5 block font-medium text-gray-700 text-sm'
              >
                {t('knowledge.datasetNameLabel')} <span className='text-red-500'>*</span>
              </label>
              <Input
                id='ragflow-form-name'
                placeholder={t('knowledge.datasetNamePlaceholder')}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                data-testid='knowledge:ragflow:form:name'
              />
            </div>
            <div>
              <label
                htmlFor='ragflow-form-desc'
                className='mb-1.5 block font-medium text-gray-700 text-sm'
              >
                {t('knowledge.datasetDescLabel')}
              </label>
              <textarea
                id='ragflow-form-desc'
                placeholder={t('knowledge.datasetDescPlaceholder')}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
                className='w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-gray-900 text-sm placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'
                data-testid='knowledge:ragflow:form:desc'
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setShowFormDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!formName.trim() || submitting}
              data-testid='knowledge:ragflow:form:submit'
            >
              {submitting
                ? editTarget
                  ? t('common.saving')
                  : t('common.creating')
                : editTarget
                  ? t('common.save')
                  : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete knowledge base confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge.confirmDeleteDataset')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge.confirmDeleteDatasetDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className='bg-red-600 hover:bg-red-700'
              disabled={deleting}
              data-testid='knowledge:ragflow:delete:confirm'
            >
              {deleting ? t('common.deleting') : t('knowledge.deleteDataset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
