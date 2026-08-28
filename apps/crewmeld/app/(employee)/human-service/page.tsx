'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Handoff {
  id: string
  conversationId: string
  customerUserId: string
  employeeName: string | null
  channel: string
  title: string | null
  status: string
  createdAt: string
}
interface Message {
  id: string
  role: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
}

const clientMessageId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export default function HumanServicePage() {
  const [handoffs, setHandoffs] = useState<Handoff[]>([])
  const [selected, setSelected] = useState<Handoff | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('open')
  const load = useCallback(async () => {
    const response = await fetch(`/api/employee/human-service/handoffs?status=${status}`)
    if (response.ok) {
      const body = (await response.json()) as { data?: Handoff[] }
      setHandoffs(body.data ?? [])
    }
  }, [status])
  useEffect(() => {
    void load()
  }, [load])
  const select = async (handoff: Handoff) => {
    setSelected(handoff)
    const response = await fetch(
      `/api/employee/conversations/${handoff.conversationId}/messages?limit=100`
    )
    if (response.ok) {
      const body = (await response.json()) as { data?: Message[] }
      setMessages(body.data ?? [])
    }
  }
  const claim = async () => {
    if (!selected) return
    await fetch(`/api/employee/human-service/handoffs/${selected.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim' }),
    })
    await load()
  }
  const close = async () => {
    if (!selected) return
    await fetch(`/api/employee/human-service/handoffs/${selected.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close' }),
    })
    setSelected(null)
    await load()
  }
  const reply = async () => {
    if (!selected || !draft.trim()) return
    const response = await fetch(
      `/api/employee/conversations/${selected.conversationId}/human-reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft.trim() }),
      }
    )
    if (response.ok) {
      setMessages((items) => [
        ...items,
        {
          id: clientMessageId(),
          role: 'assistant',
          content: draft.trim(),
          metadata: {
            source: 'human_agent',
            senderType: 'human_agent',
          },
          createdAt: new Date().toISOString(),
        },
      ])
      setDraft('')
    }
  }
  return (
    <div className='flex h-[calc(100vh-3rem)] flex-col gap-4' data-testid='human-service:page'>
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='font-bold text-2xl'>人工客服工作台</h1>
          <p className='text-gray-500 text-sm'>查看待处理会话并直接回复用户</p>
        </div>
        <div className='flex gap-2'>
          <Button
            variant={status === 'open' ? 'default' : 'outline'}
            onClick={() => setStatus('open')}
          >
            待处理
          </Button>
          <Button
            variant={status === 'assigned' ? 'default' : 'outline'}
            onClick={() => setStatus('assigned')}
          >
            处理中
          </Button>
          <Button
            variant={status === 'resolved' ? 'default' : 'outline'}
            onClick={() => setStatus('resolved')}
          >
            已结束
          </Button>
        </div>
      </div>
      <div className='grid min-h-0 flex-1 grid-cols-[320px_1fr] overflow-hidden rounded-lg border'>
        <div className='overflow-y-auto border-r' data-testid='human-service:handoffs'>
          {handoffs.length === 0 ? (
            <p className='p-6 text-gray-500 text-sm'>暂无会话</p>
          ) : (
            handoffs.map((item) => (
              <button
                type='button'
                key={item.id}
                onClick={() => void select(item)}
                className={`w-full border-b p-4 text-left hover:bg-gray-50 ${selected?.id === item.id ? 'bg-blue-50' : ''}`}
              >
                <div className='font-medium'>
                  {item.title || `用户 ${item.customerUserId.slice(0, 8)}`}
                </div>
                <div className='text-gray-500 text-xs'>
                  {item.employeeName ?? '数字员工'} · {item.channel}
                </div>
                <div className='mt-1 text-gray-400 text-xs'>
                  {new Date(item.createdAt).toLocaleString()}
                </div>
              </button>
            ))
          )}
        </div>
        <div className='flex min-h-0 flex-col'>
          {!selected ? (
            <div className='m-auto text-gray-500'>选择一个会话开始处理</div>
          ) : (
            <>
              <div className='flex items-center justify-between border-b p-4'>
                <div>
                  <div className='font-medium'>会话 {selected.conversationId.slice(0, 8)}</div>
                  <div className='text-gray-500 text-xs'>客户：{selected.customerUserId}</div>
                </div>
                <div className='flex gap-2'>
                  <Button size='sm' variant='outline' onClick={() => void claim()}>
                    接管
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => void close()}>
                    结束会话
                  </Button>
                </div>
              </div>
              <div className='flex-1 space-y-3 overflow-y-auto p-4'>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={
                      message.metadata?.source === 'human_agent' || message.role === 'assistant'
                        ? 'ml-auto max-w-[75%] rounded-lg bg-blue-50 p-3'
                        : 'max-w-[75%] rounded-lg bg-gray-100 p-3'
                    }
                  >
                    <div className='mb-1 font-medium text-xs'>
                      {message.metadata?.source === 'human_agent'
                        ? '人工客服'
                        : message.role === 'assistant'
                          ? '数字员工'
                          : '用户'}
                    </div>
                    <div className='whitespace-pre-wrap text-sm'>{message.content}</div>
                    <div className='mt-1 text-gray-400 text-xs'>
                      {new Date(message.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
              {selected.status !== 'resolved' && (
                <div className='flex gap-2 border-t p-4'>
                  <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void reply()
                      }
                    }}
                    placeholder='输入回复内容…'
                    data-testid='human-service:reply-input'
                  />
                  <Button onClick={() => void reply()} data-testid='human-service:reply'>
                    发送
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
