'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Headset, Loader2, MessageSquare, Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslation } from '@/hooks/use-translation'
import type { ChatKnowledgeBase } from '@/lib/conversation/chat-knowledge'
import { type MessageFileAttachment, useConversationStore } from '@/stores/conversation/store'
import { KnowledgeScopeBar } from './knowledge-scope-bar'
import { MessageBubble } from './message-bubble'

interface ChatPanelProps {
  conversationId: string | null
  employeeId?: string
}

interface TopQuestion {
  id: string
  question: string
}

interface ModeSwitchTarget {
  token: number
  employeeId?: string
  initialConversationId: string | null
  conversationId: string | null
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
    createConversation,
  } = useConversationStore()

  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serviceMode, setServiceMode] = useState<'ai' | 'human'>('ai')
  const [serviceModeLoading, setServiceModeLoading] = useState(false)
  const [modeSwitching, setModeSwitching] = useState(false)
  const [knowledgeBases, setKnowledgeBases] = useState<ChatKnowledgeBase[]>([])
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>([])
  const [topQuestions, setTopQuestions] = useState<TopQuestion[]>([])
  const [topLoading, setTopLoading] = useState(false)
  const [topError, setTopError] = useState<string | null>(null)
  const [topRequestVersion, setTopRequestVersion] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const topRequestControllerRef = useRef<AbortController | null>(null)
  const topRequestTokenRef = useRef(0)
  const isSubmittingRef = useRef(false)
  const serviceModeRequestTokenRef = useRef(0)
  const serviceModeReadyConversationRef = useRef<string | null>(null)
  const modeSwitchingRef = useRef(false)
  const modeSwitchTokenRef = useRef(0)
  const modeSwitchTargetRef = useRef<ModeSwitchTarget | null>(null)
  const knowledgeSwitchingRef = useRef(false)
  const currentConversationIdRef = useRef(conversationId)
  const currentEmployeeIdRef = useRef(employeeId)
  currentConversationIdRef.current = conversationId
  currentEmployeeIdRef.current = employeeId

  const selectedKnowledgeBase =
    selectedKnowledgeBaseIds.length === 1
      ? knowledgeBases.find((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBaseIds[0])
      : undefined
  const serviceModeInitializing =
    Boolean(conversationId) &&
    (serviceModeLoading || serviceModeReadyConversationRef.current !== conversationId)

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

  useEffect(() => {
    setKnowledgeBases([])
    setSelectedKnowledgeBaseIds([])
    setTopQuestions([])
    setTopError(null)
    topRequestControllerRef.current?.abort()
    topRequestTokenRef.current += 1
    if (!employeeId) return
    let cancelled = false
    void fetch(`/api/employee/employees/${employeeId}/chat-knowledge-bases`)
      .then(async (response) => {
        if (!response.ok) return []
        const body = (await response.json()) as { data?: ChatKnowledgeBase[] }
        return body.data ?? []
      })
      .then((datasets) => {
        if (!cancelled) setKnowledgeBases(datasets)
      })
      .catch(() => {
        if (!cancelled) setKnowledgeBases([])
      })
    return () => {
      cancelled = true
    }
  }, [employeeId])

  useEffect(() => {
    setTopQuestions([])
    setTopError(null)
    topRequestControllerRef.current?.abort()

    if (!employeeId || !selectedKnowledgeBase) {
      setTopLoading(false)
      return
    }

    const controller = new AbortController()
    const token = ++topRequestTokenRef.current
    topRequestControllerRef.current = controller
    setTopLoading(true)

    void fetch(
      `/api/employee/employees/${employeeId}/chat-knowledge-bases/${selectedKnowledgeBase.id}/questions/top?topN=3`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load top questions')
        const body = (await response.json()) as { data?: TopQuestion[] }
        return Array.isArray(body.data) ? body.data.slice(0, 3) : []
      })
      .then((questions) => {
        if (controller.signal.aborted || token !== topRequestTokenRef.current) return
        setTopQuestions(questions)
      })
      .catch(() => {
        if (controller.signal.aborted || token !== topRequestTokenRef.current) return
        setTopError('加载高频问题失败')
      })
      .finally(() => {
        if (!controller.signal.aborted && token === topRequestTokenRef.current) {
          setTopLoading(false)
        }
      })

    return () => controller.abort()
  }, [selectedKnowledgeBase, topRequestVersion])

  useEffect(() => {
    const pendingModeSwitch = modeSwitchTargetRef.current
    const adoptsPendingConversation = Boolean(
      modeSwitchingRef.current &&
        pendingModeSwitch &&
        pendingModeSwitch.employeeId === employeeId &&
        pendingModeSwitch.conversationId === conversationId
    )
    if (!adoptsPendingConversation) {
      modeSwitchTokenRef.current += 1
      modeSwitchingRef.current = false
      modeSwitchTargetRef.current = null
      setModeSwitching(false)
    }
    if (!conversationId) {
      setServiceMode('ai')
      setServiceModeLoading(false)
      serviceModeReadyConversationRef.current = null
      return
    }
    const controller = new AbortController()
    const token = ++serviceModeRequestTokenRef.current
    serviceModeReadyConversationRef.current = null
    setServiceModeLoading(true)
    void fetch(`/api/employee/conversations/${conversationId}/events`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const body = (await response.json()) as { data?: { mode?: string } }
        if (controller.signal.aborted || token !== serviceModeRequestTokenRef.current) return
        setServiceMode(body.data?.mode === 'human_service' ? 'human' : 'ai')
        serviceModeReadyConversationRef.current = conversationId
        setServiceModeLoading(false)
      })
      .catch(() => {
        // If the mode cannot be read, keep quick questions disabled rather than
        // risking an AI send while the conversation might be in human mode.
      })
    return () => {
      controller.abort()
    }
  }, [conversationId, employeeId])

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

  const beginSubmitting = useCallback(() => {
    if (isSubmittingRef.current) return false
    isSubmittingRef.current = true
    setIsSubmitting(true)
    return true
  }, [])

  const finishSubmitting = useCallback(() => {
    isSubmittingRef.current = false
    setIsSubmitting(false)
  }, [])

  const sendAiText = useCallback(
    async (content: string) => {
      await sendMessage(
        content,
        conversationId ? undefined : employeeId,
        undefined,
        selectedKnowledgeBaseIds
      )
    },
    [conversationId, employeeId, selectedKnowledgeBaseIds, sendMessage]
  )

  const sendText = useCallback(
    async (content: string) => {
      if (!beginSubmitting()) return
      try {
        await sendAiText(content)
      } finally {
        finishSubmitting()
      }
    },
    [beginSubmitting, finishSubmitting, sendAiText]
  )

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (
      (!trimmed && pendingFiles.length === 0) ||
      isStreaming ||
      isUploading ||
      isSubmittingRef.current ||
      !beginSubmitting()
    )
      return

    try {
    const filesToUpload = [...pendingFiles]
    setInput('')
    setPendingFiles([])

    // Ensure the conversation exists BEFORE uploading any files, so the upload
    // lands in the conversation's NFS conv-io dir (uploads with no
    // conversationId used to fall back to MinIO under a synthetic `user-<id>`
    // key, which the SOP seed / tools never see). Text-only sends don't need
    // this — sendMessage creates the conversation lazily.
    let convId = conversationId
    if (!convId && employeeId && (filesToUpload.length > 0 || serviceMode === 'human')) {
      convId = await createConversation(employeeId)
      if (!convId) {
        // Creation failed — restore pending files so the user can retry.
        setPendingFiles(filesToUpload)
        return
      }
    }

    // Upload files into the conversation's NFS store.
    const uploadedFiles: MessageFileAttachment[] = []
    if (filesToUpload.length > 0) {
      setIsUploading(true)
      try {
        for (const file of filesToUpload) {
          const formData = new FormData()
          formData.append('file', file)
          if (convId) formData.append('conversationId', convId)
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
    if (serviceMode === 'human' && convId) {
      await fetch(`/api/employee/conversations/${convId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'human_customer_message',
          data: { content: finalContent, files: uploadedFiles },
        }),
      })
      await loadMessages(convId)
      return
    }

    if (uploadedFiles.length === 0) {
      await sendAiText(finalContent)
      return
    }

    await sendMessage(
      finalContent,
      conversationId ? undefined : employeeId,
      uploadedFiles,
      selectedKnowledgeBaseIds
    )
    } finally {
      finishSubmitting()
    }
  }, [
    input,
    pendingFiles,
    isStreaming,
    isUploading,
    sendMessage,
    createConversation,
    conversationId,
    employeeId,
    serviceMode,
    loadMessages,
    selectedKnowledgeBaseIds,
    beginSubmitting,
    finishSubmitting,
    sendAiText,
  ])

  const handleKnowledgeScopeChange = useCallback(
    async (ids: string[]) => {
      if (
        knowledgeSwitchingRef.current ||
        (ids.length === selectedKnowledgeBaseIds.length &&
          ids.every((id, index) => id === selectedKnowledgeBaseIds[index]))
      )
        return

      knowledgeSwitchingRef.current = true
      try {
        if (conversationId && employeeId) {
          const nextConversationId = await createConversation(employeeId)
          if (!nextConversationId) return
        }
        topRequestControllerRef.current?.abort()
        topRequestTokenRef.current += 1
        setTopQuestions([])
        setTopError(null)
        setTopLoading(ids.length === 1)
        setSelectedKnowledgeBaseIds(ids)
      } finally {
        knowledgeSwitchingRef.current = false
      }
    },
    [conversationId, createConversation, employeeId, selectedKnowledgeBaseIds]
  )

  const retryTopQuestions = useCallback(() => {
    setTopRequestVersion((version) => version + 1)
  }, [])

  const toggleServiceMode = useCallback(async () => {
    if (modeSwitchingRef.current || serviceModeInitializing) return
    modeSwitchingRef.current = true
    setModeSwitching(true)
    const token = ++modeSwitchTokenRef.current
    const targetEmployeeId = employeeId
    modeSwitchTargetRef.current = {
      token,
      employeeId: targetEmployeeId,
      initialConversationId: conversationId,
      conversationId,
    }
    const nextMode = serviceMode === 'ai' ? 'human' : 'ai'
    try {
      let targetId = conversationId
      if (!targetId && employeeId) {
        targetId = await createConversation(employeeId)
        if (!targetId) return
        if (token !== modeSwitchTokenRef.current || !modeSwitchTargetRef.current) return
        modeSwitchTargetRef.current.conversationId = targetId
      }
      if (!targetId) return
      const response = await fetch(`/api/employee/conversations/${targetId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'service_mode.changed', data: { mode: nextMode } }),
      })
      const target = modeSwitchTargetRef.current
      const sameTarget =
        target?.token === token &&
        target.employeeId === targetEmployeeId &&
        currentEmployeeIdRef.current === targetEmployeeId &&
        (currentConversationIdRef.current === target.conversationId ||
          (target.initialConversationId === null && currentConversationIdRef.current === null))
      if (response.ok && sameTarget && token === modeSwitchTokenRef.current) {
        setServiceMode(nextMode)
      }
    } finally {
      if (token === modeSwitchTokenRef.current) {
        modeSwitchingRef.current = false
        modeSwitchTargetRef.current = null
        setModeSwitching(false)
      }
    }
  }, [conversationId, createConversation, employeeId, serviceMode, serviceModeInitializing])

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
      <KnowledgeScopeBar
        datasets={knowledgeBases}
        selectedIds={selectedKnowledgeBaseIds}
        onChange={handleKnowledgeScopeChange}
      />
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

          {selectedKnowledgeBase && (
            <section
              className='mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-3'
              data-testid='chat:top-questions'
              aria-busy={topLoading}
            >
              <h2 className='mb-2 font-medium text-blue-900 text-sm'>您可能想咨询以下问题</h2>
              {topLoading ? (
                <div className='flex items-center gap-2 text-blue-700 text-sm' role='status' aria-live='polite'>
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  正在加载高频问题
                </div>
              ) : topError ? (
                <div className='flex items-center justify-between gap-2 text-red-600 text-sm' role='alert'>
                  <span>高频问题加载失败</span>
                  <Button type='button' size='sm' variant='outline' onClick={retryTopQuestions}>
                    重试
                  </Button>
                </div>
              ) : topQuestions.length === 0 ? (
                <p className='text-gray-600 text-sm' role='status' aria-live='polite'>
                  暂无高频问题，您可以直接输入问题
                </p>
              ) : (
                <div className='flex flex-wrap gap-2'>
                  {topQuestions.map((question) => (
                    <Button
                      key={question.id}
                      type='button'
                      variant='outline'
                      disabled={
                        isStreaming ||
                        isUploading ||
                        isSubmitting ||
                        modeSwitching ||
                        serviceModeInitializing ||
                        serviceMode === 'human'
                      }
                      onClick={() => void sendText(question.question)}
                      className='h-auto whitespace-normal px-3 py-2 text-left text-sm'
                    >
                      {question.question}
                    </Button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className='border-gray-200 border-t bg-white px-4 py-3'>
        <div className='mx-auto max-w-3xl'>
          <div className='mb-2 flex items-center justify-between'>
            <span className='text-gray-500 text-xs'>
              {serviceMode === 'ai' ? 'AI 智能回复' : '人工客服回复'}
            </span>
            <Button
              type='button'
              size='sm'
              variant={serviceMode === 'human' ? 'default' : 'outline'}
              onClick={toggleServiceMode}
              disabled={serviceModeInitializing || isSubmitting || modeSwitching}
              data-testid='chat:service-mode-toggle'
              title='切换 AI 或人工客服模式'
            >
              <Headset className='mr-1.5 h-3.5 w-3.5' />
              {serviceMode === 'ai' ? '转人工客服' : '切回 AI'}
            </Button>
          </div>
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
              disabled={isStreaming || isUploading || isSubmitting}
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
              disabled={isStreaming || isUploading || isSubmitting}
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
              disabled={
                (!input.trim() && pendingFiles.length === 0) ||
                isStreaming ||
                isUploading ||
                isSubmitting
              }
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
