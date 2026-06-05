'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Loader2, MessageSquare, Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslation } from '@/hooks/use-translation'
import { type MessageFileAttachment, useConversationStore } from '@/stores/conversation/store'
import { MessageBubble } from './message-bubble'

interface ChatPanelProps {
  conversationId: string | null
  employeeId?: string
}

export function ChatPanel({ conversationId, employeeId }: ChatPanelProps) {
  const { t } = useTranslation()
  const {
    messages,
    isStreaming,
    streamingContent,
    activeToolExecutions,
    progressMessage,
    loadMessages,
    sendMessage,
  } = useConversationStore()

  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Cache viewport ref to avoid querySelector on every scroll
  useEffect(() => {
    viewportRef.current =
      scrollRef.current?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]') ?? null
  }, [])

  useEffect(() => {
    if (conversationId) {
      loadMessages(conversationId)
    }
  }, [conversationId, loadMessages])

  // Poll for new messages (detect async backend messages like approval results, SOP completion notifications)
  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(() => {
      if (!isStreaming) {
        loadMessages(conversationId)
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [conversationId, isStreaming, loadMessages])

  // Auto-scroll to bottom — only when user is near the bottom, to avoid interrupting history reading
  const isNearBottomRef = useRef(true)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 80
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport && isNearBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [messages, streamingContent, progressMessage])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if ((!trimmed && pendingFiles.length === 0) || isStreaming || isUploading) return

    const filesToUpload = [...pendingFiles]
    setInput('')
    setPendingFiles([])

    // Upload files to MinIO
    const uploadedFiles: MessageFileAttachment[] = []
    if (filesToUpload.length > 0) {
      setIsUploading(true)
      try {
        for (const file of filesToUpload) {
          const formData = new FormData()
          formData.append('file', file)
          if (conversationId) formData.append('conversationId', conversationId)
          const res = await fetch('/api/employee/conversations/files/upload', {
            method: 'POST',
            body: formData,
          })
          if (res.ok) {
            const json = await res.json()
            if (json.file) {
              uploadedFiles.push(json.file as MessageFileAttachment)
            }
          }
        }
      } catch {
        // Still send text message even if upload fails
      } finally {
        setIsUploading(false)
      }
    }

    // Build message content: files are sent as attachment metadata only, not appended to the message body.
    // When sending files without text, content stays empty — the engine will prompt the user for intent.
    const finalContent = trimmed

    if (!finalContent && uploadedFiles.length === 0) return

    // sendMessage handles conversation creation internally (auto-creates when no active conversation, using employeeId)
    await sendMessage(
      finalContent,
      conversationId ? undefined : employeeId,
      uploadedFiles.length > 0 ? uploadedFiles : undefined
    )
  }, [input, pendingFiles, isStreaming, isUploading, sendMessage, conversationId, employeeId])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) {
      setPendingFiles((prev) => [...prev, ...files])
    }
    // Reset input to allow re-selecting the same file
    e.target.value = ''
  }, [])

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className='flex h-full flex-col'>
      {/* Message list */}
      <ScrollArea className='flex-1 px-4' ref={scrollRef}>
        <div className='mx-auto max-w-3xl py-4'>
          {!conversationId && messages.length === 0 && (
            <div className='flex flex-col items-center justify-center py-20 text-gray-400'>
              <MessageSquare className='mb-3 h-10 w-10' />
              <p className='text-sm'>{t('conversation.sendMessageToStart')}</p>
            </div>
          )}

          {messages
            .filter((msg) => {
              if (msg.role === 'tool') return false
              if (msg.role === 'assistant' && !msg.content) return false
              return true
            })
            .map((msg) => (
              <MessageBubble
                key={msg.id}
                id={msg.id}
                role={msg.role}
                content={msg.content}
                references={msg.role === 'assistant' ? msg.references : undefined}
                files={msg.files}
              />
            ))}

          {/* Streaming assistant message */}
          {isStreaming && streamingContent && (
            <MessageBubble
              id='streaming'
              role={'assistant' as const}
              content={streamingContent}
              isStreaming
            />
          )}

          {/* Active tool executions */}
          {activeToolExecutions.map((te) => {
            // Prefer the displayMessage pushed by the backend (follows the user's input language)
            const fallbackName = te.toolName.startsWith('sop_')
              ? t('conversation.sopTypeLabel')
              : te.toolName
            const message =
              te.displayMessage ??
              (te.status === 'running'
                ? t('conversation.executingType', { name: fallbackName })
                : t('conversation.executedType', { name: fallbackName }))
            return (
              <div
                key={te.toolCallId}
                className='mx-auto my-2 flex max-w-lg items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-blue-700 text-sm'
              >
                {te.status === 'running' && <Loader2 className='h-3 w-3 animate-spin' />}
                <span>{message}</span>
              </div>
            )
          })}

          {/* Progress / loading indicator */}
          {isStreaming && !streamingContent && activeToolExecutions.length === 0 && (
            <div className='my-2 flex justify-start'>
              <div className='flex items-center gap-2 rounded-2xl bg-gray-100 px-4 py-3 text-gray-500 text-sm'>
                <Loader2 className='h-4 w-4 animate-spin' />
                {progressMessage || t('conversation.thinkingLabel')}
              </div>
            </div>
          )}

          {/* Progress during tool execution (SOP polling progress) */}
          {isStreaming && progressMessage && activeToolExecutions.length > 0 && (
            <div className='mx-auto my-2 flex max-w-lg items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-amber-700 text-sm'>
              <Loader2 className='h-3 w-3 animate-spin' />
              <span>{progressMessage}</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className='border-gray-200 border-t bg-white px-4 py-3'>
        <div className='mx-auto max-w-3xl'>
          {/* Pending files preview */}
          {pendingFiles.length > 0 && (
            <div className='mb-2 flex flex-wrap gap-1.5'>
              {pendingFiles.map((file, i) => (
                <span
                  key={`${file.name}-${i}`}
                  className='inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-gray-700 text-xs'
                >
                  <FileText className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                  <span className='max-w-[150px] truncate'>{file.name}</span>
                  <span className='shrink-0 text-[10px] text-gray-400'>
                    {file.size < 1024
                      ? `${file.size}B`
                      : file.size < 1024 * 1024
                        ? `${(file.size / 1024).toFixed(0)}KB`
                        : `${(file.size / 1024 / 1024).toFixed(1)}MB`}
                  </span>
                  <button
                    type='button'
                    className='shrink-0 rounded p-0.5 hover:bg-gray-200'
                    onClick={() => removePendingFile(i)}
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className='flex items-end gap-2'>
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type='file'
              multiple
              className='hidden'
              onChange={handleFileSelect}
            />

            {/* Attachment button */}
            <Button
              type='button'
              size='icon'
              variant='ghost'
              disabled={isStreaming || isUploading}
              onClick={() => fileInputRef.current?.click()}
              className='h-10 w-10 shrink-0 rounded-xl text-gray-400 hover:text-gray-600'
              title={t('conversation.attachmentTitle')}
              data-testid='chat:attach'
            >
              <Paperclip className='h-4 w-4' />
            </Button>

            <textarea
              ref={textareaRef}
              data-testid='chat:input:message'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('conversation.inputPlaceholder')}
              rows={1}
              disabled={isStreaming || isUploading}
              className='flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50'
              style={{ maxHeight: '120px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = 'auto'
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`
              }}
            />

            <Button
              data-testid='chat:send'
              size='icon'
              disabled={(!input.trim() && pendingFiles.length === 0) || isStreaming || isUploading}
              onClick={handleSend}
              className='h-10 w-10 shrink-0 rounded-xl'
            >
              {isStreaming || isUploading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <Send className='h-4 w-4' />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
