'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  AlignJustify,
  AlignLeft,
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/core/utils/cn'
import type { RagflowDocumentChunkItem, RagflowDocumentInfo } from '@/lib/ragflow/types'
import { useTranslation } from '@/hooks/use-translation'

const TEXT_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log']
const XLSX_EXTENSIONS = ['xlsx', 'xls']

function getExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

interface XlsxSheet {
  name: string
  rows: string[][]
}

export default function DocumentDetailPage() {
  const { t } = useTranslation()
  const { id, documentId } = useParams<{ id: string; documentId: string }>()

  // Document info
  const [doc, setDoc] = useState<RagflowDocumentInfo | null>(null)
  const [docLoading, setDocLoading] = useState(true)
  const [docError, setDocError] = useState<string | null>(null)

  // File content
  const [fileType, setFileType] = useState<'text' | 'md' | 'pdf' | 'xlsx' | 'other'>('other')
  const [textContent, setTextContent] = useState<string | null>(null)
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[]>([])
  const [xlsxActiveSheet, setXlsxActiveSheet] = useState(0)
  const [fileLoading, setFileLoading] = useState(true)
  const [fileError, setFileError] = useState<string | null>(null)

  // Chunks
  const [chunks, setChunks] = useState<RagflowDocumentChunkItem[]>([])
  const [chunksTotal, setChunksTotal] = useState(0)
  const [chunksLoading, setChunksLoading] = useState(true)
  const [chunksError, setChunksError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [fullView, setFullView] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load document info
  useEffect(() => {
    setDocLoading(true)
    fetch(`/api/employee/ragflow/datasets/${id}/documents/${documentId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setDoc(json.data as RagflowDocumentInfo)
        else setDocError(json.error ?? t('knowledge.ragflowDocInfoFailed'))
      })
      .catch(() => setDocError(t('knowledge.ragflowDocInfoFailed')))
      .finally(() => setDocLoading(false))
  }, [id, documentId, t])

  // Load file content
  useEffect(() => {
    if (!doc) return
    const ext = getExt(doc.name)
    setFileLoading(true)
    setFileError(null)
    setTextContent(null)
    setPdfBlobUrl(null)
    setXlsxSheets([])
    setXlsxActiveSheet(0)

    if (ext === 'pdf') {
      setFileType('pdf')
      fetch(`/api/employee/ragflow/datasets/${id}/documents/${documentId}?download=true`)
        .then(async (r) => {
          if (!r.ok) {
            setFileError(t('knowledge.ragflowFileLoadFailed'))
            return
          }
          const blob = await r.blob()
          const url = URL.createObjectURL(blob)
          setPdfBlobUrl(url)
        })
        .catch(() => setFileError(t('knowledge.ragflowFileLoadFailed')))
        .finally(() => setFileLoading(false))
    } else if (XLSX_EXTENSIONS.includes(ext)) {
      setFileType('xlsx')
      fetch(`/api/employee/ragflow/datasets/${id}/documents/${documentId}?download=true`)
        .then(async (r) => {
          if (!r.ok) {
            setFileError(t('knowledge.ragflowFileLoadFailed'))
            return
          }
          const buffer = await r.arrayBuffer()
          const XLSX = await import('xlsx')
          const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
          const sheets: XlsxSheet[] = workbook.SheetNames.map((name) => {
            const ws = workbook.Sheets[name]
            const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
              header: 1,
              defval: '',
            }) as string[][]
            return { name, rows }
          })
          setXlsxSheets(sheets)
        })
        .catch(() => setFileError(t('knowledge.ragflowFileLoadFailed')))
        .finally(() => setFileLoading(false))
    } else if (ext === 'md') {
      setFileType('md')
      fetch(`/api/employee/ragflow/datasets/${id}/documents/${documentId}?download=true`)
        .then(async (r) => {
          if (!r.ok) {
            setFileError(t('knowledge.ragflowFileLoadFailed'))
            return
          }
          const text = await r.text()
          setTextContent(text)
        })
        .catch(() => setFileError(t('knowledge.ragflowFileLoadFailed')))
        .finally(() => setFileLoading(false))
    } else if (TEXT_EXTENSIONS.includes(ext)) {
      setFileType('text')
      fetch(`/api/employee/ragflow/datasets/${id}/documents/${documentId}?download=true`)
        .then(async (r) => {
          if (!r.ok) {
            setFileError(t('knowledge.ragflowFileLoadFailed'))
            return
          }
          const text = await r.text()
          setTextContent(text)
        })
        .catch(() => setFileError(t('knowledge.ragflowFileLoadFailed')))
        .finally(() => setFileLoading(false))
    } else {
      setFileType('other')
      setFileLoading(false)
    }
  }, [doc, id, documentId, t])

  // Cleanup blob URL
  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl)
    }
  }, [pdfBlobUrl])

  // Load chunks
  const loadChunks = useCallback(
    async (keywords?: string) => {
      setChunksLoading(true)
      setChunksError(null)
      try {
        const qs = keywords
          ? `?keywords=${encodeURIComponent(keywords)}&page_size=100`
          : '?page_size=100'
        const res = await fetch(
          `/api/employee/ragflow/datasets/${id}/documents/${documentId}/chunks${qs}`
        )
        const json = await res.json()
        if (json.success) {
          setChunks(json.data?.chunks ?? [])
          setChunksTotal(json.data?.total ?? 0)
        } else {
          setChunksError(json.error ?? t('knowledge.ragflowChunksFetchFailed'))
        }
      } catch {
        setChunksError(t('knowledge.ragflowChunksFetchFailed'))
      } finally {
        setChunksLoading(false)
      }
    },
    [id, documentId, t]
  )

  useEffect(() => {
    loadChunks()
  }, [loadChunks])

  // Debounced search
  function handleSearchChange(val: string) {
    setSearchInput(val)
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => {
      setSearch(val)
      loadChunks(val || undefined)
    }, 400)
  }

  function handleDownload() {
    const a = document.createElement('a')
    a.href = `/api/employee/ragflow/datasets/${id}/documents/${documentId}?download=true`
    a.download = doc?.name ?? 'document'
    a.click()
  }

  const activeSheet = xlsxSheets[xlsxActiveSheet]

  return (
    <div className='flex h-screen flex-col bg-background'>
      {/* Header */}
      <div className='flex h-14 shrink-0 items-center gap-3 border-b px-4'>
        <Link href={`/knowledge/datasets/${id}`}>
          <Button variant='ghost' size='sm' className='gap-1.5'>
            <ArrowLeft className='h-4 w-4' />
            {t('knowledge.ragflowBack')}
          </Button>
        </Link>
        <div className='h-4 w-px bg-border' />
        {docLoading ? (
          <span className='text-muted-foreground text-sm'>
            {t('knowledge.ragflowLoadingEllipsis')}
          </span>
        ) : doc ? (
          <div className='flex items-center gap-2'>
            <FileText className='h-4 w-4 text-muted-foreground' />
            <span className='font-medium text-sm'>{doc.name}</span>
            <span className='text-muted-foreground text-xs'>({formatSize(doc.size)})</span>
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div className='flex min-h-0 flex-1'>
        {/* Left: file content */}
        <div className='flex w-1/2 flex-col border-r'>
          <div className='flex h-10 shrink-0 items-center justify-between border-b px-4'>
            <span className='font-medium text-muted-foreground text-xs'>
              {t('knowledge.ragflowFileContent')}
            </span>
            {fileType === 'md' && textContent !== null && (
              <span className='rounded bg-purple-100 px-1.5 py-0.5 font-medium text-[10px] text-purple-600'>
                {t('knowledge.ragflowMarkdownPreview')}
              </span>
            )}
            {fileType === 'xlsx' && xlsxSheets.length > 0 && (
              <span className='rounded bg-green-100 px-1.5 py-0.5 font-medium text-[10px] text-green-600'>
                {t('knowledge.ragflowExcelPreview')}
              </span>
            )}
          </div>

          {/* XLSX sheet tabs */}
          {fileType === 'xlsx' && xlsxSheets.length > 1 && (
            <div className='flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5'>
              {xlsxSheets.map((sheet, idx) => (
                <button
                  key={sheet.name}
                  type='button'
                  onClick={() => setXlsxActiveSheet(idx)}
                  className={cn(
                    'shrink-0 rounded px-2.5 py-1 font-medium text-xs transition-colors',
                    idx === xlsxActiveSheet
                      ? 'bg-green-100 text-green-700'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  {sheet.name}
                </button>
              ))}
            </div>
          )}

          <div className='min-h-0 flex-1 overflow-auto'>
            {fileLoading ? (
              <div className='flex h-full items-center justify-center'>
                <Loader2 className='h-6 w-6 animate-spin text-muted-foreground' />
              </div>
            ) : fileError ? (
              <div className='flex h-full flex-col items-center justify-center gap-2 text-destructive'>
                <AlertCircle className='h-6 w-6' />
                <span className='text-sm'>{fileError}</span>
              </div>
            ) : fileType === 'md' && textContent !== null ? (
              <div className='prose prose-sm dark:prose-invert prose-table:w-full max-w-none prose-code:rounded prose-td:border prose-th:border prose-td:border-border prose-th:border-border prose-code:bg-gray-100 prose-pre:bg-gray-900 prose-th:bg-gray-100 p-6 prose-pre:p-4 prose-code:px-1 prose-td:px-3 prose-th:px-3 prose-code:py-0.5 prose-td:py-2 prose-th:py-2 prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-gray-800 prose-code:text-sm prose-pre:text-gray-100 dark:prose-th:bg-gray-800'>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{textContent}</ReactMarkdown>
              </div>
            ) : fileType === 'text' && textContent !== null ? (
              <pre className='whitespace-pre-wrap break-words p-4 font-mono text-foreground text-xs leading-relaxed'>
                {textContent}
              </pre>
            ) : fileType === 'pdf' && pdfBlobUrl ? (
              <iframe
                src={pdfBlobUrl}
                className='h-full w-full border-none'
                title={doc?.name ?? 'PDF'}
              />
            ) : fileType === 'xlsx' && activeSheet ? (
              <div className='overflow-auto'>
                {activeSheet.rows.length === 0 ? (
                  <div className='flex h-32 items-center justify-center text-muted-foreground text-sm'>
                    {t('knowledge.ragflowSheetEmpty')}
                  </div>
                ) : (
                  <table className='w-full border-collapse text-xs'>
                    <thead>
                      <tr>
                        {activeSheet.rows[0].map((cell, ci) => (
                          <th
                            key={ci}
                            className='whitespace-nowrap border border-border bg-muted px-3 py-2 text-left font-medium text-foreground'
                          >
                            {String(cell)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeSheet.rows.slice(1).map((row, ri) => (
                        <tr key={ri} className={ri % 2 === 0 ? 'bg-background' : 'bg-muted/30'}>
                          {row.map((cell, ci) => (
                            <td
                              key={ci}
                              className='whitespace-nowrap border border-border px-3 py-2 text-foreground'
                            >
                              {String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <div className='flex h-full flex-col items-center justify-center gap-3'>
                <FileText className='h-12 w-12 text-muted-foreground/40' />
                <span className='text-muted-foreground text-sm'>
                  {t('knowledge.ragflowUnsupportedFormat')}
                </span>
                <Button variant='outline' size='sm' className='gap-1.5' onClick={handleDownload}>
                  <Download className='h-4 w-4' />
                  {t('knowledge.ragflowDownloadFile')}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Right: chunks */}
        <div className='flex w-1/2 flex-col'>
          {/* Toolbar */}
          <div className='flex h-12 shrink-0 items-center gap-2 border-b px-3'>
            <div className='relative flex-1'>
              <Search className='-translate-y-1/2 absolute top-1/2 left-2.5 h-3.5 w-3.5 text-muted-foreground' />
              <Input
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={t('knowledge.ragflowSearchChunks')}
                className='h-8 pl-8 text-xs'
              />
            </div>
            <Button
              variant={fullView ? 'secondary' : 'ghost'}
              size='sm'
              className='h-8 gap-1.5 px-2 text-xs'
              onClick={() => setFullView((v) => !v)}
              title={
                fullView
                  ? t('knowledge.ragflowToggleCompactView')
                  : t('knowledge.ragflowToggleFullView')
              }
            >
              {fullView ? (
                <AlignJustify className='h-3.5 w-3.5' />
              ) : (
                <AlignLeft className='h-3.5 w-3.5' />
              )}
              {fullView ? t('knowledge.ragflowFullView') : t('knowledge.ragflowCompactView')}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='h-8 w-8 p-0'
              onClick={() => loadChunks(search || undefined)}
              title={t('knowledge.ragflowRefresh')}
            >
              <RefreshCw className='h-3.5 w-3.5' />
            </Button>
          </div>

          {/* Chunks count */}
          <div className='flex h-8 shrink-0 items-center border-b px-3'>
            <span className='text-muted-foreground text-xs'>
              {search
                ? t('knowledge.ragflowChunksSearch', { total: chunksTotal, search })
                : t('knowledge.ragflowChunksTotal', { total: chunksTotal })}
            </span>
          </div>

          {/* Chunks list */}
          <div className='min-h-0 flex-1 overflow-y-auto p-3'>
            {chunksLoading ? (
              <div className='flex h-32 items-center justify-center'>
                <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
              </div>
            ) : chunksError ? (
              <div className='flex h-32 flex-col items-center justify-center gap-2 text-destructive'>
                <AlertCircle className='h-5 w-5' />
                <span className='text-sm'>{chunksError}</span>
              </div>
            ) : chunks.length === 0 ? (
              <div className='flex h-32 items-center justify-center text-muted-foreground text-sm'>
                {search ? t('knowledge.ragflowNoMatchChunks') : t('knowledge.ragflowNoChunks')}
              </div>
            ) : (
              <div className='flex flex-col gap-2'>
                {chunks.map((chunk, idx) => (
                  <div
                    key={chunk.id}
                    className='rounded-lg border bg-card p-3 text-xs leading-relaxed'
                  >
                    <div className='mb-1.5 flex items-center gap-1.5'>
                      <span className='rounded bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground'>
                        #{idx + 1}
                      </span>
                    </div>
                    <p
                      className={`text-foreground ${fullView ? 'whitespace-pre-wrap break-words' : 'line-clamp-4'}`}
                    >
                      {chunk.content}
                    </p>
                    {chunk.images && chunk.images.length > 0 && (
                      <div className='mt-3 flex flex-wrap gap-2'>
                        {chunk.images.map((image, imageIndex) => (
                          <img
                            key={image.id}
                            src={image.url}
                            alt={`${doc?.name ?? t('knowledge.ragflowFileContent')} - ${imageIndex + 1}`}
                            loading='lazy'
                            className='max-h-64 max-w-full rounded-md border object-contain'
                            onError={(event) => {
                              event.currentTarget.hidden = true
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
