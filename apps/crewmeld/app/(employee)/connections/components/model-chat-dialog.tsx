'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/core/utils/cn'
import type { ModelConfigData } from '@/lib/models/types'
import { useTranslation } from '@/hooks/use-translation'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ModelChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: ModelConfigData | null
}

export function ModelChatDialog({ open, onOpenChange, config }: ModelChatDialogProps) {
  const { t, tMessage } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setMessages([])
      setInput('')
      setError(null)
    }
  }, [open])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(async () => {
    if (!config || !input.trim() || loading) return

    const userMessage: ChatMessage = { role: 'user', content: input.trim() }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/employee/models/${config.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages }),
      })

      const body = await res.json()

      if (!res.ok || !body.success) {
        setError(tMessage(body) || t('connections.chatRequestFailed'))
        setMessages(nextMessages) // keep the user's message in the thread
        return
      }

      const assistantMessage: ChatMessage = { role: 'assistant', content: body.data.content }
      setMessages([...nextMessages, assistantMessage])
    } catch {
      setError(t('common.networkError'))
    } finally {
      setLoading(false)
    }
  }, [config, input, messages, loading, t, tMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleClear = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  if (!config) return null

  const modelLabel =
    config.modelName ?? config.providerMeta.defaultModel ?? config.providerMeta.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[80vh] max-h-[720px] max-w-2xl flex-col p-0'>
        <DialogHeader className='shrink-0 border-gray-200 border-b px-5 py-4'>
          <div className='flex items-center justify-between'>
            <div>
              <DialogTitle className='text-base'>
                {t('connections.chatTitle', { name: config.displayName })}
              </DialogTitle>
              <p className='mt-0.5 text-gray-400 text-xs'>
                {config.providerMeta.name} · {modelLabel}
              </p>
            </div>
            {messages.length > 0 && (
              <Button
                variant='ghost'
                size='sm'
                className='h-7 text-gray-400 text-xs hover:text-gray-600'
                onClick={handleClear}
              >
                {t('connections.chatClear')}
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Messages */}
        <div className='flex-1 overflow-y-auto px-5 py-4'>
          {messages.length === 0 && (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <p className='font-medium text-gray-500 text-sm'>{t('connections.chatStartHint')}</p>
              <p className='mt-1 text-gray-400 text-xs'>
                {t('connections.chatUsingModel', {
                  model: modelLabel,
                  provider: config.providerMeta.name,
                })}
              </p>
            </div>
          )}

          <div className='space-y-4'>
            {messages.map((msg, i) => (
              <div
                key={i}
                className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                    msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
                  )}
                  data-testid={`chat:bubble:${i}`}
                >
                  <pre className='whitespace-pre-wrap font-sans'>{msg.content}</pre>
                </div>
              </div>
            ))}

            {loading && (
              <div className='flex justify-start'>
                <div className='flex items-center gap-2 rounded-2xl bg-gray-100 px-4 py-2.5'>
                  <Loader2 className='h-4 w-4 animate-spin text-gray-400' />
                  <span className='text-gray-400 text-sm'>{t('connections.chatThinking')}</span>
                </div>
              </div>
            )}

            {error && (
              <div className='rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-red-600 text-sm'>
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className='shrink-0 border-gray-200 border-t px-5 py-3'>
          <div className='flex items-end gap-2'>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('connections.chatPlaceholder')}
              rows={2}
              disabled={loading}
              className='flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-blue-400 focus:bg-white disabled:opacity-50'
              data-testid='chat:input:message'
            />
            <Button
              size='icon'
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className='h-10 w-10 shrink-0 rounded-xl'
              data-testid='chat:send'
            >
              {loading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <Send className='h-4 w-4' />
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
