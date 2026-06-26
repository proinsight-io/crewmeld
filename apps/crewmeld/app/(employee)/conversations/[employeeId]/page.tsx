'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { ChatPanel } from '@/components/conversation/chat-panel'
import { ConversationHistory } from '@/components/conversation/conversation-history'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'
import { useConversationStore } from '@/stores/conversation/store'

interface EmployeeInfo {
  id: string
  name: string
  avatar: string | null
}

export default function EmployeeChatPage() {
  const { t } = useTranslation()
  const params = useParams()
  const router = useRouter()
  const employeeId = params.employeeId as string

  const {
    activeConversationId,
    conversations,
    createConversation,
    loadConversations,
    loadMessages,
    setActiveConversation,
  } = useConversationStore()

  const [employee, setEmployee] = useState<EmployeeInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const initializingRef = useRef<string | null>(null)

  // Load employee info — clear stale state immediately when switching employees
  useEffect(() => {
    setIsLoading(true)
    setInitialized(false)
    initializingRef.current = null
    setActiveConversation(null)
    fetch(`/api/employee/employees/${employeeId}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setEmployee({ id: json.data.id, name: json.data.name, avatar: json.data.avatar })
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [employeeId])

  // On employee switch: validate and initialize the conversation (runs once)
  useEffect(() => {
    if (isLoading || !employee) return
    if (initializingRef.current === employeeId) return
    initializingRef.current = employeeId

    loadConversations(employeeId).then(() => {
      const state = useConversationStore.getState()
      const employeeConvs = state.conversations.filter((c) => c.employeeId === employeeId)
      const currentId = state.activeConversationId

      // If the active conversation already belongs to this employee, use it directly
      if (currentId && employeeConvs.some((c) => c.id === currentId)) {
        loadMessages(currentId)
        setInitialized(true)
        return
      }

      // Otherwise select this employee's most recent conversation, or fall to an empty chat
      if (employeeConvs.length > 0) {
        const latest = employeeConvs[0]
        setActiveConversation(latest.id)
        loadMessages(latest.id)
      } else {
        setActiveConversation(null)
      }
      setInitialized(true)
    })
  }, [isLoading, employee, employeeId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <div className='flex h-[calc(100vh-48px)] items-center justify-center'>
        <Loader2 className='h-6 w-6 animate-spin text-gray-400' />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className='flex h-[calc(100vh-48px)] flex-col items-center justify-center gap-3'>
        <p className='text-gray-500'>{t('conversations.employeeNotFound')}</p>
        <Button variant='outline' size='sm' onClick={() => router.push('/conversations')}>
          {t('conversations.backToList')}
        </Button>
      </div>
    )
  }

  return (
    <div className='flex h-[calc(100vh-48px)] flex-col'>
      {/* Header */}
      <div className='flex items-center gap-3 border-gray-200 border-b bg-white px-4 py-3'>
        <Button
          variant='ghost'
          size='icon'
          className='h-8 w-8'
          onClick={() => router.push('/conversations')}
        >
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div className='flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xl'>
          {employee.avatar ?? employee.name.slice(0, 1)}
        </div>
        <span className='font-medium text-gray-900 text-sm'>{employee.name}</span>
      </div>

      {/* Main area */}
      <div className='flex flex-1 overflow-hidden'>
        {/* Sidebar */}
        <div className='hidden w-64 lg:block'>
          <ConversationHistory employeeId={employeeId} />
        </div>

        {/* Chat */}
        <div className='flex-1'>
          {!initialized ? (
            <div className='flex h-full items-center justify-center text-gray-400'>
              <Loader2 className='h-5 w-5 animate-spin' />
            </div>
          ) : activeConversationId ? (
            <ChatPanel conversationId={activeConversationId} />
          ) : (
            <ChatPanel conversationId={null} employeeId={employeeId} />
          )}
        </div>
      </div>
    </div>
  )
}
