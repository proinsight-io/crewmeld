'use client'

import { useRef, useState } from 'react'
import type { KnowledgeBaseType } from '@crewmeld/db/schema'
import { AlertCircle, FileText, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/use-translation'
import { getQaClientFileError, getQaPreviewUrl } from './ragflow-upload-dialog-logic'

interface RagflowUploadDialogProps {
  datasetId: string
  datasetType: KnowledgeBaseType
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

const ACCEPTED_TYPES =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.html,.htm,.json,.png,.jpg,.jpeg'

/** Maximum 32 files per batch upload */
const MAX_BATCH_FILES = 32
/** Local deployment: max 1 GB total upload size per batch */
const MAX_TOTAL_SIZE_BYTES = 1 * 1024 * 1024 * 1024

interface QaPreviewData {
  headers: string[]
  rows: Array<Record<string, string | number>>
  validRowCount: number
  previewRowLimit: number
  errors: Array<{ code: string; row?: number; field?: string }>
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function RagflowUploadDialog({
  datasetId,
  datasetType,
  open,
  onOpenChange,
  onSuccess,
}: RagflowUploadDialogProps) {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [parseOnUpload, setParseOnUpload] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [qaPreview, setQaPreview] = useState<QaPreviewData | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isQa = datasetType === 'qa'

  function validateFiles(files: File[]): string | null {
    if (isQa) {
      const qaError = getQaClientFileError(files)
      if (qaError === 'FILE_COUNT') return t('knowledge.qaUploadSingleFile')
      if (qaError === 'INVALID_TYPE') return t('knowledge.qaUploadInvalidType')
      if (qaError === 'FILE_TOO_LARGE') return t('knowledge.qaUploadTooLarge')
      return null
    }
    if (files.length > MAX_BATCH_FILES) {
      return t('knowledge.uploadErrorTooMany', { max: MAX_BATCH_FILES, count: files.length })
    }
    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      return t('knowledge.uploadErrorTooLarge', { size: formatSize(totalSize) })
    }
    return null
  }

  function applyFiles(files: File[]) {
    const validationError = validateFiles(files)
    if (validationError) {
      setError(validationError)
      return
    }
    setSelectedFiles(files)
    setQaPreview(null)
    setError(null)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      applyFiles(Array.from(e.target.files))
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files) {
      applyFiles(Array.from(e.dataTransfer.files))
    }
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index))
    setError(null)
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return
    setUploading(true)
    setError(null)

    try {
      if (isQa) {
        const formData = new FormData()
        formData.append('file', selectedFiles[0] as File)
        const res = await fetch(getQaPreviewUrl(datasetId), { method: 'POST', body: formData })
        const json = (await res.json()) as { success?: boolean; data?: QaPreviewData }
        if (!res.ok || !json.data) throw new Error(t('knowledge.qaPreviewFailed'))
        setQaPreview(json.data)
        return
      }
      for (const file of selectedFiles) {
        const formData = new FormData()
        formData.append('file', file)

        const parseParam = parseOnUpload ? '' : '?parse=false'
        const res = await fetch(
          `/api/employee/ragflow/datasets/${datasetId}/documents${parseParam}`,
          { method: 'POST', body: formData }
        )

        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          throw new Error(
            (json as { error?: string }).error ??
              t('knowledge.uploadFileFailed', { name: file.name })
          )
        }
      }

      setSelectedFiles([])
      setQaPreview(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('knowledge.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  function handleClose(v: boolean) {
    if (!v) {
      setSelectedFiles([])
      setError(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    onOpenChange(v)
  }

  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('knowledge.uploadTitle')}</DialogTitle>
        </DialogHeader>

        <div className='space-y-4 py-2'>
          {/* Drag-and-drop / click-to-upload area */}
          <div
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
              dragOver
                ? 'border-blue-400 bg-blue-50'
                : 'border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            data-testid='knowledge:ragflow:upload:dropzone'
          >
            <Upload className='mb-3 h-8 w-8 text-gray-400' />
            <p className='font-medium text-gray-700 text-sm'>
              {selectedFiles.length > 0
                ? t('knowledge.uploadSelected', {
                    count: selectedFiles.length,
                    size: formatSize(totalSize),
                  })
                : t('knowledge.uploadDrag')}
            </p>
            <p className='mt-1 text-gray-500 text-xs'>
              {t('knowledge.uploadInfo', { max: MAX_BATCH_FILES })}
            </p>
            <p className='mt-0.5 text-gray-400 text-xs'>
              {t(isQa ? 'knowledge.qaUploadFormats' : 'knowledge.uploadFormats')}
            </p>
          </div>

          <input
            ref={fileInputRef}
            type='file'
            accept={isQa ? '.csv,text/csv' : ACCEPTED_TYPES}
            multiple
            className='hidden'
            onChange={handleFileChange}
            data-testid='knowledge:ragflow:upload:input'
          />

          {/* Selected files list */}
          {selectedFiles.length > 0 && (
            <ul className='max-h-36 space-y-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-2'>
              {selectedFiles.map((f, i) => (
                <li
                  key={i}
                  className='flex items-center justify-between gap-2 text-gray-600 text-xs'
                >
                  <span className='flex min-w-0 items-center gap-1.5'>
                    <FileText className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                    <span className='truncate'>{f.name}</span>
                    <span className='shrink-0 text-gray-400'>({formatSize(f.size)})</span>
                  </span>
                  <button
                    type='button'
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFile(i)
                    }}
                    className='shrink-0 text-gray-400 hover:text-red-500'
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Upload limit notes */}
          <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700 text-xs'>
            <p className='font-medium'>{t('knowledge.uploadLimitTitle')}</p>
            <ul className='mt-1 list-inside list-disc space-y-0.5'>
              <li>{t('knowledge.uploadLimitLocal')}</li>
              <li>{t('knowledge.uploadLimitForbidden')}</li>
            </ul>
          </div>

          {/* Parse-on-upload option */}
          {!isQa && (
            <div className='flex items-center gap-2'>
              <Switch
                id='parse-on-upload'
                checked={parseOnUpload}
                onCheckedChange={setParseOnUpload}
                data-testid='knowledge:ragflow:upload:parse-on-upload'
              />
              <Label htmlFor='parse-on-upload' className='cursor-pointer text-gray-700 text-sm'>
                {t('knowledge.parseOnUpload')}
              </Label>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className='flex items-start gap-2 text-red-600 text-sm'>
              <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
              <span>{error}</span>
            </div>
          )}

          {isQa && qaPreview && (
            <div className='space-y-3' data-testid='knowledge:ragflow:qa-preview'>
              <div className='text-gray-700 text-sm'>
                {t('knowledge.qaPreviewSummary', {
                  valid: qaPreview.validRowCount,
                  errors: qaPreview.errors.length,
                })}
              </div>
              <div className='max-h-48 overflow-auto rounded-md border border-gray-200'>
                <table className='w-full text-left text-xs'>
                  <thead className='sticky top-0 bg-gray-50'>
                    <tr>
                      {qaPreview.headers.map((header) => (
                        <th key={header} className='px-2 py-1.5 font-medium text-gray-600'>
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {qaPreview.rows.map((row) => (
                      <tr key={String(row.row)} className='border-gray-100 border-t'>
                        {qaPreview.headers.map((header) => (
                          <td key={header} className='max-w-48 truncate px-2 py-1.5 text-gray-700'>
                            {String(row[header] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {qaPreview.errors.length > 0 && (
                <ul className='max-h-24 overflow-auto text-red-600 text-xs'>
                  {qaPreview.errors.map((previewError, index) => (
                    <li key={`${previewError.code}-${previewError.row ?? 0}-${index}`}>
                      {t('knowledge.qaPreviewError', {
                        row: previewError.row ?? '-',
                        code: previewError.code,
                      })}
                    </li>
                  ))}
                </ul>
              )}
              <p className='text-amber-700 text-xs'>{t('knowledge.qaPreviewImportDeferred')}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => handleClose(false)} disabled={uploading}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleUpload}
            disabled={selectedFiles.length === 0 || uploading || (isQa && qaPreview !== null)}
            data-testid='knowledge:ragflow:upload:submit'
          >
            {isQa
              ? t('knowledge.qaUploadPreviewAction')
              : uploading
                ? t('knowledge.uploading')
                : selectedFiles.length > 0
                  ? t('knowledge.uploadCountSuffix', { count: selectedFiles.length })
                  : t('knowledge.uploadBtn')}
          </Button>
          {isQa && qaPreview && (
            <Button disabled data-testid='knowledge:ragflow:qa-preview:confirm'>
              {t('knowledge.qaPreviewConfirmDisabled')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
