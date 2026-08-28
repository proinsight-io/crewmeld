'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Download,
  Eye,
  File,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
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
import { Switch } from '@/components/ui/switch'
import type { RagflowDocumentInfo } from '@/lib/ragflow/types'
import { useTranslation } from '@/hooks/use-translation'

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function parseRagflowDate(value: string | number | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isNaN(num) && num > 0) {
    // Unix seconds (float, e.g. 1706278800.12) vs milliseconds (e.g. 1706278800123)
    const ms = num < 1e12 ? num * 1000 : num
    return new Date(ms)
  }
  // ISO string or other formats parseable by Date
  const d = new Date(value as string)
  return Number.isNaN(d.getTime()) ? null : d
}

function formatDate(value: string | number | undefined | null, locale: string): string {
  const d = parseRagflowDate(value)
  if (!d) return '-'
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getCreatedAt(
  doc: import('@/lib/ragflow/types').RagflowDocumentInfo
): string | number | undefined {
  return doc.created_at ?? doc.create_time
}

type SortOrder = 'asc' | 'desc' | null

function getRunState(
  doc: import('@/lib/ragflow/types').RagflowDocumentInfo
): 'running' | 'done' | 'fail' | 'unstart' {
  const run = doc.run
  const status = doc.status
  // Compatible with both numeric string and English string formats
  if (run === '1' || run === 'RUNNING' || run?.toLowerCase() === 'running' || status === 'RUNNING')
    return 'running'
  if (run === '4' || run === 'FAIL' || run?.toLowerCase() === 'fail' || status === 'FAIL')
    return 'fail'
  if (run === '3' || run === 'DONE' || run?.toLowerCase() === 'done' || status === 'DONE')
    return 'done'
  if (run === '0' || run === 'UNSTART' || run?.toLowerCase() === 'unstart' || status === 'UNSTART')
    return 'unstart'
  // Fallback: if chunk count > 0, treat as parsed
  const chunkCount = doc.chunk_count ?? doc.chunk_num ?? 0
  if (chunkCount > 0) return 'done'
  return 'unstart'
}

interface ToastItem {
  id: number
  message: string
}

function ToastPortal({ toasts }: { toasts: ToastItem[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted) return null
  return createPortal(
    <div className='pointer-events-none fixed right-6 bottom-6 z-50 flex flex-col items-end gap-2'>
      {toasts.map((t) => (
        <div
          key={t.id}
          className='fade-in slide-in-from-bottom-2 flex animate-in items-center gap-2 rounded-lg bg-green-500 px-4 py-2.5 font-medium text-sm text-white shadow-lg duration-200'
        >
          <svg className='h-4 w-4 shrink-0' viewBox='0 0 20 20' fill='currentColor'>
            <path
              fillRule='evenodd'
              d='M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z'
              clipRule='evenodd'
            />
          </svg>
          {t.message}
        </div>
      ))}
    </div>,
    document.body
  )
}

interface RagflowDocumentListProps {
  datasetId: string
  onTotalSizeChange?: (bytes: number) => void
  onExtOptionsChange?: (exts: string[]) => void
  nameFilter?: string
  extFilter?: string
}

export function RagflowDocumentList({
  datasetId,
  onTotalSizeChange,
  onExtOptionsChange,
  nameFilter = '',
  extFilter = '',
}: RagflowDocumentListProps) {
  const { t, locale } = useTranslation()
  const [documents, setDocuments] = useState<RagflowDocumentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [viewTarget, setViewTarget] = useState<RagflowDocumentInfo | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [parsingIds, setParsingIds] = useState<Set<string>>(new Set())
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchParsing, setBatchParsing] = useState(false)
  const [batchToggling, setBatchToggling] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [batchExporting, setBatchExporting] = useState(false)
  const [parseDetailTarget, setParseDetailTarget] = useState<RagflowDocumentInfo | null>(null)
  const [sortOrder, setSortOrder] = useState<SortOrder>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastCounterRef = useRef(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function showToast(message: string) {
    const id = ++toastCounterRef.current
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000)
  }

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${datasetId}/documents`)
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error ?? t('knowledge.fetchDocsFailed'))
        return
      }
      const docs: RagflowDocumentInfo[] = json.data ?? []
      setDocuments(docs)
      setFailedIds(new Set(docs.filter((d) => getRunState(d) === 'fail').map((d) => d.id)))
      onTotalSizeChange?.(docs.reduce((sum, d) => sum + (d.size ?? 0), 0))
      setError(null)
    } catch {
      setError(t('knowledge.cannotConnect'))
    } finally {
      setLoading(false)
    }
  }, [datasetId, t])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  useEffect(() => {
    const hasRunning = documents.some((d) => getRunState(d) === 'running')
    const hasProcessing = hasRunning || documents.some((d) => getRunState(d) === 'unstart')
    const interval = hasRunning ? 1_000 : 10_000

    if (hasProcessing) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(fetchDocuments, interval)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [documents, fetchDocuments])

  useEffect(() => {
    const exts = Array.from(
      new Set(
        documents
          .map((d) => {
            const dot = d.name.lastIndexOf('.')
            return dot >= 0 ? d.name.slice(dot + 1).toLowerCase() : ''
          })
          .filter(Boolean)
      )
    ).sort()
    onExtOptionsChange?.(exts)
  }, [documents, onExtOptionsChange])

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/employee/ragflow/datasets/${datasetId}/documents/${deleteTarget.id}`,
        { method: 'DELETE' }
      )
      const json = await res.json()
      if (res.ok && json.success) {
        setDocuments((prev) => prev.filter((d) => d.id !== deleteTarget.id))
        setDeleteTarget(null)
      } else {
        setError(json.error ?? t('knowledge.deleteDocFailed'))
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleToggleEnabled(docId: string, currentStatus: string) {
    const newEnabled = currentStatus !== '1'
    setDocuments((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, status: newEnabled ? '1' : '0' } : d))
    )
    setTogglingId(docId)
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      })
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === docId ? { ...d, status: currentStatus } : d))
        )
        setError(json.error ?? t('knowledge.updateStatusFailed'))
      }
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, status: currentStatus } : d))
      )
      setError(t('common.networkError'))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDownload(doc: RagflowDocumentInfo) {
    setDownloadingId(doc.id)
    try {
      const res = await fetch(
        `/api/employee/ragflow/datasets/${datasetId}/documents/${doc.id}?download=true`
      )
      if (!res.ok) {
        setError(t('knowledge.downloadFailed'))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = doc.name
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError(t('knowledge.downloadFailed'))
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleRename() {
    if (!renameTarget || !newName.trim()) return
    setRenaming(true)
    try {
      const res = await fetch(
        `/api/employee/ragflow/datasets/${datasetId}/documents/${renameTarget.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim() }),
        }
      )
      const json = (await res.json()) as { success: boolean; error?: string }
      if (res.ok && json.success) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === renameTarget.id ? { ...d, name: newName.trim() } : d))
        )
        setRenameTarget(null)
      } else {
        setError(json.error ?? t('knowledge.renameFailed'))
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setRenaming(false)
    }
  }

  function handleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(documents.map((d) => d.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  function handleSelectOne(docId: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(docId)
      } else {
        next.delete(docId)
      }
      return next
    })
  }

  async function handleBatchParse() {
    if (selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    setBatchParsing(true)
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids }),
      })
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) {
        setError(json.error ?? t('knowledge.parseTriggerFailed'))
      } else {
        showToast(t('knowledge.batchParseTrigger', { count: ids.length }))
        setSelectedIds(new Set())
        fetchDocuments()
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setBatchParsing(false)
    }
  }

  async function handleBatchToggleEnabled(enabled: boolean) {
    const ids = Array.from(selectedIds)
    setBatchToggling(true)
    try {
      await Promise.all(
        ids.map((docId) =>
          fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/${docId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          })
        )
      )
      setDocuments((prev) =>
        prev.map((d) => (selectedIds.has(d.id) ? { ...d, status: enabled ? '1' : '0' } : d))
      )
      showToast(
        enabled
          ? t('knowledge.batchEnabled', { count: ids.length })
          : t('knowledge.batchDisabled', { count: ids.length })
      )
      setSelectedIds(new Set())
    } catch {
      setError(t('knowledge.batchFailed'))
    } finally {
      setBatchToggling(false)
    }
  }

  async function handleBatchExport() {
    const ids = Array.from(selectedIds)
    setBatchExporting(true)
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids }),
      })
      if (!res.ok) {
        setError(t('knowledge.batchExportFailed'))
        return
      }
      const disposition = res.headers.get('content-disposition') ?? ''
      const match = /filename\*=UTF-8''([^;]+)/.exec(disposition)
      const filename = match ? decodeURIComponent(match[1]) : 'documents-export.zip'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setSelectedIds(new Set())
    } catch {
      setError(t('knowledge.batchExportFailed'))
    } finally {
      setBatchExporting(false)
    }
  }

  async function handleBatchDelete() {
    const ids = Array.from(selectedIds)
    setBatchDeleting(true)
    try {
      await Promise.all(
        ids.map((docId) =>
          fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/${docId}`, {
            method: 'DELETE',
          })
        )
      )
      setDocuments((prev) => prev.filter((d) => !selectedIds.has(d.id)))
      showToast(t('knowledge.batchDeleted', { count: ids.length }))
      setSelectedIds(new Set())
    } catch {
      setError(t('knowledge.batchDeleteFailed'))
    } finally {
      setBatchDeleting(false)
    }
  }

  async function handleParse(docId: string) {
    setParsingIds((prev) => new Set(prev).add(docId))
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${datasetId}/documents/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: [docId] }),
      })
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) {
        setError(json.error ?? t('knowledge.parseTriggerFailed'))
      } else {
        showToast(t('knowledge.parseTriggerSuccess'))
        fetchDocuments()
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setParsingIds((prev) => {
        const next = new Set(prev)
        next.delete(docId)
        return next
      })
    }
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className='animate-pulse rounded-lg border border-gray-200 bg-white p-4'>
            <div className='h-4 w-48 rounded bg-gray-200' />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className='rounded-lg border border-amber-200 bg-amber-50 p-4 text-center'>
        <AlertCircle className='mx-auto mb-2 h-6 w-6 text-amber-500' />
        <p className='text-amber-700 text-sm'>{error}</p>
        <Button
          variant='outline'
          size='sm'
          className='mt-3'
          data-testid='knowledge:ragflow:error:retry'
          onClick={() => {
            setError(null)
            fetchDocuments()
          }}
        >
          <RefreshCw className='mr-2 h-3.5 w-3.5' />
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  if (documents.length === 0) {
    return (
      <div className='rounded-lg border border-gray-300 border-dashed bg-white py-10 text-center'>
        <File className='mx-auto mb-3 h-10 w-10 text-gray-300' />
        <p className='text-gray-500 text-sm'>{t('knowledge.emptyDocs')}</p>
      </div>
    )
  }

  const allSelected = documents.length > 0 && selectedIds.size === documents.length
  const someSelected = selectedIds.size > 0 && selectedIds.size < documents.length

  function toggleSortOrder() {
    setSortOrder((prev) => (prev === null ? 'desc' : prev === 'desc' ? 'asc' : null))
  }

  // Extract unique sorted file extensions from document names
  const extOptions = Array.from(
    new Set(
      documents
        .map((d) => {
          const dot = d.name.lastIndexOf('.')
          return dot >= 0 ? d.name.slice(dot + 1).toLowerCase() : ''
        })
        .filter(Boolean)
    )
  ).sort()

  const filteredDocuments = documents.filter((d) => {
    if (nameFilter && !d.name.toLowerCase().includes(nameFilter.toLowerCase())) return false
    if (extFilter) {
      const dot = d.name.lastIndexOf('.')
      const ext = dot >= 0 ? d.name.slice(dot + 1).toLowerCase() : ''
      if (ext !== extFilter) return false
    }
    return true
  })

  const displayedDocuments =
    sortOrder === null
      ? filteredDocuments
      : [...filteredDocuments].sort((a, b) => {
          const ta = parseRagflowDate(getCreatedAt(a))?.getTime() ?? 0
          const tb = parseRagflowDate(getCreatedAt(b))?.getTime() ?? 0
          return sortOrder === 'desc' ? tb - ta : ta - tb
        })

  return (
    <>
      <ToastPortal toasts={toasts} />
      {selectedIds.size > 0 && (
        <div className='mb-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2'>
          <span className='mr-1 text-blue-700 text-sm'>
            {t('knowledge.selectedCount', { count: selectedIds.size })}
          </span>
          <Button
            size='sm'
            onClick={handleBatchParse}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-parse'
          >
            {batchParsing ? (
              <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
            ) : (
              <Zap className='mr-1 h-3.5 w-3.5' />
            )}
            {batchParsing ? t('knowledge.parsing') : t('knowledge.parse')}
          </Button>
          <Button
            size='sm'
            onClick={() => handleBatchToggleEnabled(true)}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-enable'
          >
            {batchToggling ? <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' /> : null}
            {t('knowledge.batchEnable')}
          </Button>
          <Button
            size='sm'
            onClick={() => handleBatchToggleEnabled(false)}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-disable'
          >
            {t('knowledge.batchDisable')}
          </Button>
          <Button
            size='sm'
            onClick={handleBatchExport}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-export'
          >
            {batchExporting ? (
              <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
            ) : (
              <Archive className='mr-1 h-3.5 w-3.5' />
            )}
            {batchExporting ? t('knowledge.batchExporting') : t('knowledge.batchExport')}
          </Button>
          <Button
            size='sm'
            onClick={handleBatchDelete}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-delete'
          >
            {batchDeleting ? <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' /> : null}
            {batchDeleting ? t('common.deleting') : t('common.delete')}
          </Button>
          <Button
            size='sm'
            onClick={() => setSelectedIds(new Set())}
            disabled={batchParsing || batchToggling || batchDeleting || batchExporting}
            className='h-7 bg-blue-600 px-3 text-xs hover:bg-blue-700'
            data-testid='knowledge:ragflow:batch-cancel'
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}
      <div className='overflow-hidden rounded-lg border border-gray-200'>
        <table className='w-full text-sm' data-testid='knowledge:ragflow:doc-table'>
          <thead className='bg-gray-50 text-left font-medium text-gray-500 text-xs'>
            <tr>
              <th className='w-10 px-4 py-3'>
                <input
                  type='checkbox'
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className='h-4 w-4 cursor-pointer rounded border-gray-300 accent-blue-600'
                  data-testid='knowledge:ragflow:select-all'
                />
              </th>
              <th className='px-4 py-3'>{t('knowledge.colFilename')}</th>
              <th className='px-4 py-3'>{t('knowledge.colSize')}</th>
              <th className='px-4 py-3'>{t('knowledge.colChunks')}</th>
              <th className='px-4 py-3'>
                <button
                  type='button'
                  onClick={toggleSortOrder}
                  className='inline-flex items-center gap-1 hover:text-gray-700'
                  data-testid='knowledge:ragflow:sort-by-date'
                  title={t('knowledge.sortByDateTip')}
                >
                  {t('knowledge.colUploadTime')}
                  {sortOrder === null && <ChevronsUpDown className='h-3.5 w-3.5 text-gray-400' />}
                  {sortOrder === 'desc' && <ChevronDown className='h-3.5 w-3.5 text-blue-500' />}
                  {sortOrder === 'asc' && <ChevronUp className='h-3.5 w-3.5 text-blue-500' />}
                </button>
              </th>
              <th className='px-4 py-3'>{t('knowledge.colEnabled')}</th>
              <th className='px-4 py-3'>{t('knowledge.colParse')}</th>
              <th className='px-4 py-3 text-right'>{t('knowledge.colActions')}</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-gray-100 bg-white'>
            {displayedDocuments.map((doc) => (
              <tr key={doc.id} data-testid={`knowledge:ragflow:doc:${doc.id}`}>
                <td className='px-4 py-3'>
                  <input
                    type='checkbox'
                    checked={selectedIds.has(doc.id)}
                    onChange={(e) => handleSelectOne(doc.id, e.target.checked)}
                    className='h-4 w-4 cursor-pointer rounded border-gray-300 accent-blue-600'
                    data-testid={`knowledge:ragflow:doc:select:${doc.id}`}
                  />
                </td>
                <td className='px-4 py-3 font-medium text-gray-900'>
                  <Link
                    href={`/knowledge/datasets/${datasetId}/documents/${doc.id}`}
                    className='hover:text-blue-600 hover:underline'
                  >
                    {doc.name}
                  </Link>
                </td>
                <td className='px-4 py-3 text-gray-500'>{formatSize(doc.size)}</td>
                <td className='px-4 py-3 text-gray-500'>{doc.chunk_count ?? doc.chunk_num ?? 0}</td>
                <td className='px-4 py-3 text-gray-500 text-xs'>
                  {formatDate(getCreatedAt(doc), locale)}
                </td>
                <td className='px-4 py-3'>
                  <Switch
                    checked={doc.status === '1'}
                    disabled={togglingId === doc.id}
                    onCheckedChange={() => handleToggleEnabled(doc.id, doc.status)}
                  />
                </td>
                <td className='px-4 py-3'>
                  <div className='flex items-center gap-2'>
                    {(() => {
                      const state = getRunState(doc)
                      if (state === 'running') {
                        const pct = Math.round((doc.progress ?? 0) * 100)
                        return (
                          <div className='flex min-w-[90px] flex-col gap-1'>
                            <div className='flex items-center justify-between gap-1'>
                              <span className='rounded bg-blue-50 px-2 py-0.5 text-blue-600 text-xs'>
                                {t('knowledge.stateRunning')}
                              </span>
                              <span className='text-blue-500 text-xs'>{pct}%</span>
                            </div>
                            <div className='h-1 w-full overflow-hidden rounded-full bg-blue-100'>
                              <div
                                className='h-full bg-blue-500 transition-all duration-500'
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )
                      }
                      if (state === 'fail')
                        return (
                          <button
                            type='button'
                            onClick={() => setParseDetailTarget(doc)}
                            className='rounded bg-red-50 px-2 py-0.5 text-red-600 text-xs underline-offset-2 hover:bg-red-100 hover:underline'
                            title={t('knowledge.viewInfo')}
                          >
                            {t('knowledge.stateFail')}
                          </button>
                        )
                      if (state === 'done')
                        return (
                          <button
                            type='button'
                            onClick={() => setParseDetailTarget(doc)}
                            className='rounded bg-green-50 px-2 py-0.5 text-green-600 text-xs underline-offset-2 hover:bg-green-100 hover:underline'
                            title={t('knowledge.viewInfo')}
                          >
                            {t('knowledge.stateDone')}
                          </button>
                        )
                      return (
                        <span className='rounded bg-gray-100 px-2 py-0.5 text-gray-500 text-xs'>
                          {t('knowledge.stateUnstart')}
                        </span>
                      )
                    })()}
                    {getRunState(doc) !== 'running' &&
                      (() => {
                        const runState = getRunState(doc)
                        const isReparse = runState === 'done' || runState === 'fail'
                        return (
                          <button
                            type='button'
                            onClick={() => handleParse(doc.id)}
                            disabled={parsingIds.has(doc.id)}
                            title={isReparse ? t('knowledge.reparse') : t('knowledge.startParse')}
                            className={`shrink-0 rounded p-0.5 transition-colors disabled:opacity-40 ${
                              runState === 'fail'
                                ? 'text-red-400 hover:bg-red-50 hover:text-red-600'
                                : 'text-gray-400 hover:bg-green-50 hover:text-green-600'
                            }`}
                            data-testid={`knowledge:ragflow:doc:parse-btn:${doc.id}`}
                          >
                            {parsingIds.has(doc.id) ? (
                              <Loader2 className='h-4 w-4 animate-spin' />
                            ) : isReparse ? (
                              <RotateCcw className='h-4 w-4' />
                            ) : (
                              <Play className='h-4 w-4' />
                            )}
                          </button>
                        )
                      })()}
                  </div>
                </td>
                <td className='px-4 py-3'>
                  <div className='flex items-center justify-end gap-1'>
                    <button
                      type='button'
                      title={t('knowledge.viewInfo')}
                      onClick={() => setViewTarget(doc)}
                      className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                    >
                      <Eye className='h-4 w-4' />
                    </button>
                    <button
                      type='button'
                      title={t('knowledge.downloadFile')}
                      disabled={downloadingId === doc.id}
                      onClick={() => handleDownload(doc)}
                      className='rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-500 disabled:opacity-40'
                    >
                      <Download className='h-4 w-4' />
                    </button>
                    <button
                      type='button'
                      title={t('knowledge.renameFile')}
                      onClick={() => {
                        setRenameTarget({ id: doc.id, name: doc.name })
                        setNewName(doc.name)
                      }}
                      className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                    >
                      <Pencil className='h-4 w-4' />
                    </button>
                    <button
                      type='button'
                      title={t('common.delete')}
                      onClick={() => setDeleteTarget({ id: doc.id, name: doc.name })}
                      className='rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500'
                      data-testid={`knowledge:ragflow:doc:delete:${doc.id}`}
                    >
                      <Trash2 className='h-4 w-4' />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* View info dialog */}
      <Dialog open={!!viewTarget} onOpenChange={(open) => !open && setViewTarget(null)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('knowledge.fileInfoTitle')}</DialogTitle>
          </DialogHeader>
          {viewTarget && (
            <div className='space-y-3 text-sm'>
              {[
                { label: t('knowledge.fileInfoName'), value: viewTarget.name },
                { label: t('knowledge.fileInfoType'), value: viewTarget.type || '-' },
                { label: t('knowledge.fileInfoSize'), value: formatSize(viewTarget.size) },
                {
                  label: t('knowledge.fileInfoChunks'),
                  value: String(viewTarget.chunk_count ?? viewTarget.chunk_num ?? 0),
                },
                {
                  label: t('knowledge.fileInfoTokens'),
                  value: String(viewTarget.token_count ?? viewTarget.token_num ?? 0),
                },
                {
                  label: t('knowledge.fileInfoCreatedAt'),
                  value: formatDate(viewTarget.created_at ?? viewTarget.create_time, locale),
                },
                {
                  label: t('knowledge.fileInfoUpdatedAt'),
                  value: formatDate(viewTarget.updated_at ?? viewTarget.update_time, locale),
                },
              ].map(({ label, value }) => (
                <div key={label} className='flex items-start gap-3'>
                  <span className='w-20 shrink-0 text-gray-500'>{label}</span>
                  <span className='break-all text-gray-900'>{value}</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setViewTarget(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('knowledge.renameTitle')}</DialogTitle>
          </DialogHeader>
          <input
            type='text'
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            className='w-full rounded-lg border border-gray-200 px-3 py-2 text-gray-900 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'
            placeholder={t('knowledge.renamePlaceholder')}
            autoFocus
          />
          <DialogFooter>
            <Button variant='outline' onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRename} disabled={renaming || !newName.trim()}>
              {renaming ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge.confirmDeleteDoc')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge.confirmDeleteDocDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className='bg-red-600 hover:bg-red-700'
              disabled={deleting}
            >
              {deleting ? t('common.deleting') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Parse detail dialog (shared for parsed / parse-failed) */}
      <Dialog
        open={!!parseDetailTarget}
        onOpenChange={(open) => !open && setParseDetailTarget(null)}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle
              className={`flex items-center gap-2 ${parseDetailTarget && getRunState(parseDetailTarget) === 'fail' ? 'text-red-600' : 'text-green-600'}`}
            >
              <AlertCircle className='h-5 w-5' />
              {parseDetailTarget && getRunState(parseDetailTarget) === 'fail'
                ? t('knowledge.stateFail')
                : t('knowledge.parseDetailTitle')}
            </DialogTitle>
          </DialogHeader>
          {parseDetailTarget &&
            (() => {
              const doc = parseDetailTarget
              const msg = doc.progress_msg ?? ''
              // Extract all timestamps
              const allTimestamps = [...msg.matchAll(/(\d{2}:\d{2}:\d{2})/g)].map((m) => m[1])
              // Date from updated_at, time from first timestamp in progress_msg
              const baseDate = parseRagflowDate(doc.updated_at ?? doc.update_time)
              const firstTimePart = allTimestamps[0]
              let startTime = '-'
              if (baseDate && firstTimePart) {
                const [h, m, s] = firstTimePart.split(':')
                // progress_msg times are UTC; construct via Date.UTC then convert to local
                const utcDate = new Date(baseDate)
                const utc = new Date(
                  Date.UTC(
                    utcDate.getUTCFullYear(),
                    utcDate.getUTCMonth(),
                    utcDate.getUTCDate(),
                    Number(h),
                    Number(m),
                    Number(s)
                  )
                )
                const dd = String(utc.getDate()).padStart(2, '0')
                const mm = String(utc.getMonth() + 1).padStart(2, '0')
                const yyyy = utc.getFullYear()
                const hh = String(utc.getHours()).padStart(2, '0')
                const mi = String(utc.getMinutes()).padStart(2, '0')
                const ss = String(utc.getSeconds()).padStart(2, '0')
                startTime = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`
              } else if (firstTimePart) {
                startTime = firstTimePart
              }
              // Prefer duration from "Task done (Xs)"; otherwise calculate from first/last timestamp diff
              const taskDoneMatch = msg.match(/Task done \(([^)]+)\)/)
              let duration = '-'
              if (taskDoneMatch) {
                duration = taskDoneMatch[1]
              } else if (allTimestamps.length >= 2) {
                const toSec = (t: string) => {
                  const [h, m, s] = t.split(':').map(Number)
                  return h * 3600 + m * 60 + s
                }
                const diff = toSec(allTimestamps.at(-1)!) - toSec(allTimestamps[0])
                duration = diff >= 0 ? `${diff}s` : '-'
              }
              const state = getRunState(doc)

              return (
                <div className='space-y-4 text-sm'>
                  {/* Two-column info grid */}
                  <div className='grid grid-cols-2 gap-x-6 gap-y-3'>
                    <div>
                      <p className='text-gray-400 text-xs'>{t('knowledge.parseDetailFilename')}</p>
                      <p className='mt-0.5 break-all font-medium text-gray-900'>{doc.name}</p>
                    </div>
                    <div>
                      <p className='text-gray-400 text-xs'>
                        {t('knowledge.parseDetailUploadDate')}
                      </p>
                      <p className='mt-0.5 text-gray-900'>
                        {formatDate(getCreatedAt(doc), locale)}
                      </p>
                    </div>
                    <div>
                      <p className='text-gray-400 text-xs'>{t('knowledge.parseDetailFileSize')}</p>
                      <p className='mt-0.5 text-gray-900'>{formatSize(doc.size)}</p>
                    </div>
                    <div>
                      <p className='text-gray-400 text-xs'>{t('knowledge.parseDetailStartTime')}</p>
                      <p className='mt-0.5 text-gray-900'>{startTime}</p>
                    </div>
                    <div>
                      <p className='text-gray-400 text-xs'>{t('knowledge.parseDetailDuration')}</p>
                      <p className='mt-0.5 text-gray-900'>{duration}</p>
                    </div>
                    <div>
                      <p className='text-gray-400 text-xs'>{t('knowledge.parseDetailStatus')}</p>
                      <p
                        className={`mt-0.5 font-medium ${state === 'fail' ? 'text-red-600' : 'text-green-600'}`}
                      >
                        {state === 'fail' ? t('knowledge.stateFail') : t('knowledge.stateDone')}
                      </p>
                    </div>
                  </div>
                  {/* Detail log */}
                  {msg && (
                    <div>
                      <p className='mb-1.5 text-gray-400 text-xs'>
                        {t('knowledge.parseDetailLog')}
                      </p>
                      <pre className='max-h-52 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-gray-900 px-4 py-3 text-gray-100 text-xs leading-5'>
                        {msg}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })()}
          <DialogFooter>
            <Button variant='outline' onClick={() => setParseDetailTarget(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
