'use client'

import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeBaseType } from '@crewmeld/db/schema'
import { ArrowLeft, Database, HardDrive, RefreshCw, Search, Upload } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { QaQuestionList } from '@/components/knowledge/qa-question-list'
import { RagflowDocumentList } from '@/components/knowledge/ragflow-document-list'
import { RagflowUploadDialog } from '@/components/knowledge/ragflow-upload-dialog'
import { Button } from '@/components/ui/button'
import type { RagflowDataset } from '@/lib/ragflow/types'
import { useTranslation } from '@/hooks/use-translation'

export default function RagflowDatasetDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const [dataset, setDataset] = useState<
    (RagflowDataset & { type?: KnowledgeBaseType; metadata?: { id?: string } }) | null
  >(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [totalSize, setTotalSize] = useState(0)
  const [nameFilter, setNameFilter] = useState('')
  const [extFilter, setExtFilter] = useState('')
  const [extOptions, setExtOptions] = useState<string[]>([])

  function formatSize(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
  }

  const fetchDataset = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/employee/ragflow/datasets/${id}`)
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error ?? t('knowledge.ragflowFetchFailed'))
        return
      }
      setDataset(json.data)
      setError(null)
    } catch {
      setError(t('knowledge.ragflowNetworkError'))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  useEffect(() => {
    fetchDataset()
  }, [fetchDataset])

  if (loading) {
    return (
      <div>
        <div className='mb-6 flex items-center gap-3'>
          <Link href='/knowledge' className='rounded p-1 hover:bg-gray-100'>
            <ArrowLeft className='h-5 w-5 text-gray-500' />
          </Link>
          <div className='h-7 w-48 animate-pulse rounded bg-gray-200' />
        </div>
        <div className='space-y-3'>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className='h-12 animate-pulse rounded-lg bg-gray-100' />
          ))}
        </div>
      </div>
    )
  }

  if (error || !dataset) {
    return (
      <div>
        <div className='mb-6 flex items-center gap-3'>
          <Link href='/knowledge' className='rounded p-1 hover:bg-gray-100'>
            <ArrowLeft className='h-5 w-5 text-gray-500' />
          </Link>
          <h1 className='font-semibold text-2xl text-gray-900'>
            {t('knowledge.ragflowBreadcrumb')}
          </h1>
        </div>
        <div className='rounded-xl border border-red-200 bg-red-50 p-6 text-center'>
          <p className='mb-3 text-red-700'>{error ?? t('knowledge.ragflowNotFound')}</p>
          <Button
            variant='outline'
            onClick={fetchDataset}
            data-testid='knowledge:ragflow:error:retry'
          >
            <RefreshCw className='mr-2 h-4 w-4' />
            {t('common.retry')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className='mb-6 flex items-center gap-3'>
        <Link href='/knowledge' className='rounded p-1 hover:bg-gray-100'>
          <ArrowLeft className='h-5 w-5 text-gray-500' />
        </Link>
        <div className='flex-1'>
          <h1 className='font-semibold text-2xl text-gray-900'>{dataset.name}</h1>
          {dataset.description && (
            <p className='mt-1 text-gray-500 text-sm'>{dataset.description}</p>
          )}
        </div>
        <Button onClick={() => setShowUpload(true)} data-testid='knowledge:ragflow:upload-btn'>
          <Upload className='mr-2 h-4 w-4' />
          {t('knowledge.ragflowUploadDoc')}
        </Button>
      </div>

      <div className='mb-6 flex items-center gap-4 rounded-lg border border-gray-200 bg-white px-5 py-3'>
        <div className='flex shrink-0 items-center gap-2 text-gray-500 text-sm'>
          <Database className='h-4 w-4' />
          <span>{t('knowledge.ragflowDocCountSuffix', { count: dataset.document_count })}</span>
        </div>
        <div className='flex shrink-0 items-center gap-2 text-gray-500 text-sm'>
          <HardDrive className='h-4 w-4' />
          <span>{formatSize(totalSize)}</span>
        </div>
        <div className='shrink-0 text-gray-500 text-sm'>
          {t('knowledge.ragflowModelPrefix', { model: dataset.embedding_model })}
        </div>
        <div className='ml-auto flex items-center gap-2'>
          <div className='relative'>
            <Search className='-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-gray-400' />
            <input
              type='text'
              placeholder={t('knowledge.ragflowFilterName')}
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              className='w-48 rounded-lg border border-gray-200 bg-white py-1.5 pr-3 pl-9 text-gray-900 text-sm placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'
              data-testid='knowledge:ragflow:filter:name'
            />
          </div>
          <select
            value={extFilter}
            onChange={(e) => setExtFilter(e.target.value)}
            className='rounded-lg border border-gray-200 bg-white py-1.5 pr-8 pl-3 text-gray-700 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'
            data-testid='knowledge:ragflow:filter:ext'
          >
            <option value=''>{t('knowledge.ragflowFilterAllFormats')}</option>
            {extOptions.map((ext) => (
              <option key={ext} value={ext}>
                .{ext}
              </option>
            ))}
          </select>
        </div>
      </div>

      <RagflowDocumentList
        key={refreshKey}
        datasetId={id}
        onTotalSizeChange={setTotalSize}
        onExtOptionsChange={setExtOptions}
        nameFilter={nameFilter}
        extFilter={extFilter}
      />

      {dataset.type === 'qa' && <QaQuestionList knowledgeBaseId={dataset.metadata?.id ?? id} />}

      <RagflowUploadDialog
        datasetId={id}
        datasetType={dataset.type ?? 'document'}
        open={showUpload}
        onOpenChange={setShowUpload}
        onSuccess={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
