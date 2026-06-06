'use client'

import { useCallback, useState } from 'react'
import { BookOpen, Check, ChevronDown, ChevronUp, Copy, Download, FileText } from 'lucide-react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { cn } from '@/lib/core/utils/cn'
import type { SupportedLocale } from '@/lib/core/utils/formatting'
import { formatDateTimeShortI18n } from '@/lib/core/utils/formatting'
import { useTranslation } from '@/hooks/use-translation'
import type { KnowledgeChunkReference, MessageFileAttachment } from '@/stores/conversation/store'

interface MessageBubbleProps {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  toolName?: string
  isStreaming?: boolean
  references?: KnowledgeChunkReference[]
  files?: MessageFileAttachment[]
  /** Optional message timestamp, displayed below the bubble when provided */
  createdAt?: string
}

/**
 */
function rewriteMinioUrl(src: string): string {
  try {
    const url = new URL(src, window.location.origin)
    // Match ports other than the current app (MinIO direct address)
    if (/:\d{4,5}$/.test(url.host) && url.host !== window.location.host) {
      const pathParts = url.pathname.split('/')
      // Strategy 1: conversations/ or chat/ path — use [...key] proxy
      const convIdx = pathParts.findIndex((p) => p === 'conversations' || p === 'chat')
      if (convIdx > 0 && !url.search) {
        const key = pathParts.slice(convIdx).join('/')
        return `/api/employee/conversations/files/${key}`
      }
      // Strategy 2: other paths or presigned URL — use generic proxy
      const encoded = btoa(src).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return `/api/employee/conversations/files/proxy?url=${encoded}`
    }
  } catch {
    // Not a valid URL, return as-is
  }
  return src
}

/** Custom rendering components for react-markdown */
const markdownComponents: Components = {
  img({ src, alt, ...props }) {
    const proxiedSrc = src ? rewriteMinioUrl(src as string) : ''
    return (
      <a href={proxiedSrc} target='_blank' rel='noopener noreferrer' className='my-2 block'>
        <img
          src={proxiedSrc}
          alt={alt ?? ''}
          className='max-h-64 max-w-full rounded-lg border border-gray-200 object-contain'
          loading='lazy'
          {...props}
        />
      </a>
    )
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '')
    const isBlock = String(children).includes('\n')
    if (isBlock) {
      return (
        <div className='group relative my-2'>
          {match && (
            <span className='absolute top-1 right-2 text-[10px] text-gray-400 uppercase'>
              {match[1]}
            </span>
          )}
          <pre className='overflow-x-auto rounded-lg bg-gray-900 p-3 text-gray-100 text-xs leading-5'>
            <code className={className} {...props}>
              {children}
            </code>
          </pre>
        </div>
      )
    }
    return (
      <code className='rounded bg-gray-200 px-1 py-0.5 text-pink-600 text-xs' {...props}>
        {children}
      </code>
    )
  },
  table({ children }) {
    return (
      <div className='my-2 overflow-x-auto rounded-lg border border-gray-200'>
        <table className='min-w-full text-xs'>{children}</table>
      </div>
    )
  },
  thead({ children }) {
    return <thead className='bg-gray-100 text-left text-gray-600'>{children}</thead>
  },
  th({ children }) {
    return <th className='px-3 py-1.5 font-medium'>{children}</th>
  },
  td({ children }) {
    return <td className='border-gray-100 border-t px-3 py-1.5'>{children}</td>
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target='_blank'
        rel='noopener noreferrer'
        className='text-blue-600 underline decoration-blue-300 hover:decoration-blue-600'
      >
        {children}
      </a>
    )
  },
  blockquote({ children }) {
    return (
      <blockquote className='my-2 border-blue-400 border-l-4 pl-3 text-gray-600 italic'>
        {children}
      </blockquote>
    )
  },
  ul({ children }) {
    return <ul className='my-1 list-disc space-y-0.5 pl-5'>{children}</ul>
  },
  ol({ children }) {
    return <ol className='my-1 list-decimal space-y-0.5 pl-5'>{children}</ol>
  },
  hr() {
    return <hr className='my-3 border-gray-200' />
  },
}

export function MessageBubble({
  id,
  role,
  content,
  toolName,
  isStreaming,
  references,
  files,
  createdAt,
}: MessageBubbleProps) {
  const { t, locale } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!content) return
    copyToClipboard(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [content])

  if (role === 'tool') {
    return (
      <div
        data-testid={`chat:bubble:${id}`}
        className='mx-auto my-2 max-w-lg rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-gray-600 text-xs'
      >
        <span className='font-medium text-gray-500'>
          {toolName ?? t('conversation.toolLabel')}：
        </span>
        <span className='line-clamp-3'>{content ?? ''}</span>
      </div>
    )
  }

  if (role === 'system') {
    return (
      <div
        data-testid={`chat:bubble:${id}`}
        className='mx-auto my-2 max-w-lg rounded-lg bg-yellow-50 px-4 py-2 text-center text-sm text-yellow-700'
      >
        {content}
      </div>
    )
  }

  const isUser = role === 'user'
  const hasRefs = !isUser && !isStreaming && references && references.length > 0

  // Filter out attachment annotation lines for LLM ([附件: name=..., url=..., ...]), keep only user-readable content
  const displayContent =
    isUser && files && files.length > 0 && content
      ? content.replace(/\n*\[附件: [^\]]+\]\n*/g, '').trimEnd() || null
      : content

  return (
    <div
      data-testid={`chat:bubble:${id}`}
      className={cn('group my-2 flex flex-col', isUser ? 'items-end' : 'items-start')}
    >
      <div
        className={cn('flex w-full items-start gap-1', isUser ? 'flex-row-reverse' : 'flex-row')}
      >
        <div
          className={cn(
            'min-w-0 max-w-[85%] overflow-hidden break-words rounded-2xl px-4 py-3 text-sm leading-relaxed',
            isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
          )}
        >
          {isUser ? (
            displayContent && <p className='whitespace-pre-wrap'>{displayContent}</p>
          ) : (
            <div className='prose prose-sm prose-li:my-0 prose-ol:my-1 prose-p:my-1 prose-pre:my-0 prose-ul:my-1 prose-headings:mt-3 prose-headings:mb-1 max-w-none first:prose-headings:mt-0'>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={markdownComponents}
              >
                {content ?? ''}
              </ReactMarkdown>
              {isStreaming && <span className='inline-block h-4 w-1 animate-pulse bg-gray-400' />}
            </div>
          )}

          {/* File attachments */}
          {files && files.length > 0 && (
            <div className='mt-2 space-y-1.5'>
              {files.map((file) => {
                const fileUrl = `/api/employee/conversations/files/${file.key.split('/').map(encodeURIComponent).join('/')}`
                const isImage = file.mimeType.startsWith('image/')
                return isImage ? (
                  <a
                    key={file.key}
                    href={fileUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='block'
                  >
                    <img
                      src={fileUrl}
                      alt={file.name}
                      className='max-h-48 max-w-full rounded-lg border border-gray-200 object-contain'
                      loading='lazy'
                    />
                  </a>
                ) : (
                  <a
                    key={file.key}
                    href={fileUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
                      isUser
                        ? 'border-blue-400/30 bg-blue-500/20 text-blue-100 hover:bg-blue-500/30'
                        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                    )}
                  >
                    <FileText className='h-4 w-4 shrink-0' />
                    <span className='min-w-0 flex-1 truncate'>{file.name}</span>
                    <span className='shrink-0 text-[10px] opacity-60'>
                      {file.size < 1024 ? `${file.size}B` : `${(file.size / 1024).toFixed(1)}KB`}
                    </span>
                    <Download className='h-3.5 w-3.5 shrink-0 opacity-60' />
                  </a>
                )
              })}
            </div>
          )}
        </div>

        {/* Copy button */}
        {content && !isStreaming && (
          <button
            type='button'
            data-testid={`chat:bubble:copy:${id}`}
            onClick={handleCopy}
            className='mt-2 hidden shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 group-hover:block'
            title={t('conversation.copyTitle')}
          >
            {copied ? (
              <Check className='h-3.5 w-3.5 text-green-500' />
            ) : (
              <Copy className='h-3.5 w-3.5' />
            )}
          </button>
        )}
      </div>

      {/* Timestamp */}
      {createdAt && !isStreaming && (
        <p className={cn('mt-0.5 px-1 text-[10px]', isUser ? 'text-blue-400' : 'text-gray-400')}>
          {formatDateTimeShortI18n(createdAt, locale as SupportedLocale)}
        </p>
      )}

      {hasRefs && <ReferencesPanel references={references} />}
    </div>
  )
}

function ReferencesPanel({ references }: { references: KnowledgeChunkReference[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set())

  // Group by document
  const docGroups = references.reduce<
    Record<
      string,
      { documentName: string; chunks: (KnowledgeChunkReference & { globalIdx: number })[] }
    >
  >((acc, ref, idx) => {
    const key = ref.documentId || ref.documentName
    if (!acc[key]) {
      acc[key] = { documentName: ref.documentName, chunks: [] }
    }
    acc[key].chunks.push({ ...ref, globalIdx: idx })
    return acc
  }, {})
  const docList = Object.entries(docGroups)

  const toggleDoc = (key: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const docCount = docList.length

  return (
    <div className='mt-1.5 w-full max-w-[75%]'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-gray-500 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700'
      >
        <BookOpen className='h-3.5 w-3.5 shrink-0' />
        <span>
          {t('conversation.referencesTitle', { docCount, chunkCount: references.length })}
        </span>
        {open ? (
          <ChevronUp className='h-3.5 w-3.5 shrink-0' />
        ) : (
          <ChevronDown className='h-3.5 w-3.5 shrink-0' />
        )}
      </button>

      {open && (
        <div className='mt-1.5 space-y-1.5'>
          {docList.map(([key, { documentName, chunks }]) => {
            const isExpanded = expandedDocs.has(key)
            const topSimilarity = Math.max(...chunks.map((c) => c.similarity))
            return (
              <div
                key={key}
                className='overflow-hidden rounded-lg border border-gray-200 bg-white text-xs'
              >
                {/* Document row */}
                <button
                  type='button'
                  onClick={() => toggleDoc(key)}
                  className='flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-gray-50'
                >
                  <span className='text-sm'>📄</span>
                  <span className='flex-1 truncate font-medium text-gray-700' title={documentName}>
                    {documentName}
                  </span>
                  <span className='shrink-0 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-[10px] text-blue-600'>
                    {t('conversation.chunkCountLabel', { count: chunks.length })}
                  </span>
                  <span className='shrink-0 rounded-full bg-green-50 px-2 py-0.5 font-medium text-[10px] text-green-600'>
                    {t('conversation.chunkMatchLabel', {
                      percent: Math.round(topSimilarity * 100),
                    })}
                  </span>
                  {isExpanded ? (
                    <ChevronUp className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                  ) : (
                    <ChevronDown className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                  )}
                </button>

                {/* Chunk list */}
                {isExpanded && (
                  <div className='divide-y divide-gray-100 border-gray-100 border-t'>
                    {chunks.map((chunk) => (
                      <div key={chunk.chunkId} className='px-3 py-2.5'>
                        <div className='mb-1.5 space-y-0.5'>
                          <p
                            className='truncate font-medium text-[10px] text-gray-600'
                            title={documentName}
                          >
                            {documentName}
                          </p>
                          <div className='flex items-center justify-between gap-2'>
                            <span className='text-[10px] text-gray-400'>
                              📄 {t('conversation.chunkIndexLabel', { index: chunk.globalIdx + 1 })}
                            </span>
                            <span className='shrink-0 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-[10px] text-blue-600'>
                              {t('conversation.chunkMatchLabel', {
                                percent: Math.round(chunk.similarity * 100),
                              })}
                            </span>
                          </div>
                        </div>
                        <p className='line-clamp-3 text-gray-500 leading-relaxed'>
                          {chunk.content}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
