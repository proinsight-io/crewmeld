'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KnowledgeChunkReference } from '@/lib/conversation/types'
import { normalizeKnowledgeSelection } from '@/lib/conversation/chat-knowledge'
import { type Locale, messages } from '@/locales'
import { useLocaleStore } from '@/stores/locale/store'

export type { KnowledgeChunkReference }

/** File attached to a message (stored in MinIO) */
export interface MessageFileAttachment {
  key: string // S3 object key
  name: string // Original filename
  size: number // Bytes
  mimeType: string // MIME type
}

interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  toolCalls?: unknown[]
  toolCallId?: string
  toolName?: string
  tokensUsed?: number
  createdAt: string
  references?: KnowledgeChunkReference[]
  files?: MessageFileAttachment[]
}

interface ConversationSummary {
  id: string
  employeeId: string
  employeeName?: string | null
  employeeAvatar?: string | null
  title: string | null
  status: string
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
}

interface ToolExecution {
  toolCallId: string
  toolName: string
  status: 'running' | 'done'
  result?: string
  displayMessage?: string
}

interface ConversationStore {
  activeConversationId: string | null
  messages: ConversationMessage[]
  conversations: ConversationSummary[]
  isStreaming: boolean
  streamingContent: string
  activeToolExecutions: ToolExecution[]
  /** Current progress message (pushed during long-running engine operations) */
  progressMessage: string

  setActiveConversation: (id: string | null) => void
  setMessages: (messages: ConversationMessage[]) => void
  setConversations: (conversations: ConversationSummary[]) => void

  createConversation: (employeeId: string) => Promise<string | null>
  loadConversations: (employeeId?: string) => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  sendMessage: (
    content: string,
    employeeId?: string,
    files?: MessageFileAttachment[],
    knowledgeBaseIds?: string[]
  ) => Promise<void>
  closeConversation: (conversationId: string) => Promise<void>
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    (set, get) => ({
      activeConversationId: null,
      messages: [],
      conversations: [],
      isStreaming: false,
      streamingContent: '',
      activeToolExecutions: [],
      progressMessage: '',

      setActiveConversation: (id) =>
        set({
          activeConversationId: id,
          // When switching or clearing conversation, reset messages and streaming state
          messages: id ? get().messages : [],
          isStreaming: false,
          streamingContent: '',
          activeToolExecutions: [],
          progressMessage: '',
        }),
      setMessages: (messages) => set({ messages }),
      setConversations: (conversations) => set({ conversations }),

      createConversation: async (employeeId) => {
        try {
          const res = await fetch('/api/employee/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId }),
          })
          if (!res.ok) return null
          const json = await res.json()
          const conv = json.data
          const greetingMessages: ConversationMessage[] = conv.greetingMessage
            ? [conv.greetingMessage as ConversationMessage]
            : []
          set((state) => ({
            activeConversationId: conv.id,
            messages: greetingMessages,
            isStreaming: false,
            streamingContent: '',
            activeToolExecutions: [],
            conversations: [
              {
                id: conv.id,
                employeeId: conv.employeeId,
                title: null,
                status: 'active',
                messageCount: greetingMessages.length,
                lastMessageAt: greetingMessages[0]?.createdAt ?? null,
                createdAt: conv.createdAt,
              },
              ...state.conversations,
            ],
          }))
          return conv.id
        } catch {
          return null
        }
      },

      loadConversations: async (employeeId) => {
        try {
          const url = employeeId
            ? `/api/employee/conversations?employeeId=${employeeId}`
            : '/api/employee/conversations'
          const res = await fetch(url)
          if (!res.ok) return
          const json = await res.json()
          set({ conversations: json.data })
        } catch {
          // noop
        }
      },

      loadMessages: async (conversationId) => {
        // Don't load messages during streaming to avoid overwriting incoming content
        if (get().isStreaming) return
        try {
          const res = await fetch(
            `/api/employee/conversations/${conversationId}/messages?limit=100`
          )
          if (!res.ok) return
          // Streaming may have started during fetch (user sent message quickly), check again
          if (get().isStreaming) return
          const json = await res.json()
          // Check again after JSON parse to prevent overwriting incoming messages
          if (get().isStreaming) return
          const messages = (
            json.data as Array<ConversationMessage & { metadata?: Record<string, unknown> }>
          ).map((msg) => ({
            ...msg,
            references:
              msg.role === 'assistant' && Array.isArray(msg.metadata?.references)
                ? (msg.metadata.references as KnowledgeChunkReference[])
                : undefined,
            files: Array.isArray(msg.metadata?.files)
              ? (msg.metadata.files as MessageFileAttachment[])
              : undefined,
          }))
          set({
            messages,
            activeConversationId: conversationId,
            isStreaming: false,
            streamingContent: '',
            activeToolExecutions: [],
          })
        } catch {
          // noop
        }
      },

      sendMessage: async (content, employeeId, files, knowledgeBaseIds) => {
        if (get().isStreaming) return

        let conversationId = get().activeConversationId

        // Auto-create conversation when none is active, set isStreaming=true in the same set() to prevent loadMessages from interfering
        if (!conversationId && employeeId) {
          try {
            const createRes = await fetch('/api/employee/conversations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ employeeId }),
            })
            if (!createRes.ok) return
            const createJson = await createRes.json()
            const conv = createJson.data
            conversationId = conv.id
            const greetingMessages: ConversationMessage[] = conv.greetingMessage
              ? [conv.greetingMessage as ConversationMessage]
              : []

            // Atomic set: create conversation + optimistically add user message + isStreaming=true, all in one step
            const userMsg: ConversationMessage = {
              id: `temp-${Date.now()}`,
              role: 'user',
              content,
              createdAt: new Date().toISOString(),
              files,
            }
            set((state) => ({
              activeConversationId: conv.id,
              messages: [...greetingMessages, userMsg],
              isStreaming: true,
              streamingContent: '',
              activeToolExecutions: [],
              progressMessage: '',
              conversations: [
                {
                  id: conv.id,
                  employeeId: conv.employeeId,
                  title: null,
                  status: 'active',
                  messageCount: greetingMessages.length,
                  lastMessageAt: greetingMessages[0]?.createdAt ?? null,
                  createdAt: conv.createdAt,
                },
                ...state.conversations,
              ],
            }))
          } catch {
            return
          }
        } else if (!conversationId) {
          return
        } else {
          // Existing conversation: optimistically add user message
          const userMsg: ConversationMessage = {
            id: `temp-${Date.now()}`,
            role: 'user',
            content,
            createdAt: new Date().toISOString(),
            files,
          }
          set((state) => ({
            messages: [...state.messages, userMsg],
            isStreaming: true,
            streamingContent: '',
            activeToolExecutions: [],
            progressMessage: '',
          }))
        }

        try {
          const res = await fetch(`/api/employee/conversations/${conversationId}/messages/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              files,
              locale: useLocaleStore.getState().locale,
              knowledgeBaseIds: normalizeKnowledgeSelection(knowledgeBaseIds ?? []),
            }),
          })

          if (!res.ok) {
            set({ isStreaming: false })
            return
          }

          if (!res.body) {
            set({ isStreaming: false })
            return
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let assistantContent = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6)
              if (data === '[DONE]') continue

              try {
                const event = JSON.parse(data)

                switch (event.type) {
                  case 'progress': {
                    set({ progressMessage: (event.data.message as string) ?? '' })
                    break
                  }
                  case 'message:delta': {
                    assistantContent += event.data.content ?? ''
                    set({ streamingContent: assistantContent, progressMessage: '' })
                    break
                  }
                  case 'tool:start': {
                    set((state) => ({
                      activeToolExecutions: [
                        ...state.activeToolExecutions,
                        {
                          toolCallId: event.data.toolCallId,
                          toolName: event.data.toolName,
                          status: 'running',
                          displayMessage: event.data.displayMessage,
                        },
                      ],
                    }))
                    break
                  }
                  case 'tool:result': {
                    set((state) => ({
                      activeToolExecutions: state.activeToolExecutions.map((te) =>
                        te.toolCallId === event.data.toolCallId
                          ? {
                              ...te,
                              status: 'done' as const,
                              result: event.data.result,
                              displayMessage: event.data.displayMessage,
                            }
                          : te
                      ),
                    }))
                    break
                  }
                  case 'message:done': {
                    // Add final assistant message
                    const assistantMsg: ConversationMessage = {
                      id: event.data.messageId ?? `assistant-${Date.now()}`,
                      role: 'assistant',
                      content: assistantContent,
                      tokensUsed: event.data.tokensUsed,
                      references: (event.data.references as KnowledgeChunkReference[]) ?? [],
                      createdAt: new Date().toISOString(),
                    }
                    set((state) => ({
                      messages: [...state.messages, assistantMsg],
                      streamingContent: '',
                      activeToolExecutions: [],
                      // Update conversation title and message count in sidebar
                      conversations: state.conversations.map((c) =>
                        c.id === conversationId
                          ? {
                              ...c,
                              title: c.title || content.slice(0, 50),
                              messageCount: c.messageCount + 2,
                              lastMessageAt: new Date().toISOString(),
                            }
                          : c
                      ),
                    }))
                    assistantContent = ''
                    break
                  }
                  case 'message:start': {
                    if (event.data.round > 0) {
                      // New round after tool calls — reset streaming content
                      assistantContent = ''
                      set({ streamingContent: '' })
                    }
                    break
                  }
                  case 'error': {
                    const errorMsg: ConversationMessage = {
                      id: `error-${Date.now()}`,
                      role: 'system',
                      content: `${messages[useLocaleStore.getState().locale as Locale].common.errorPrefix}${event.data.message}`,
                      createdAt: new Date().toISOString(),
                    }
                    set((state) => ({
                      messages: [...state.messages, errorMsg],
                    }))
                    break
                  }
                }
              } catch {
                // Skip unparseable events
              }
            }
          }
        } finally {
          set({ isStreaming: false, streamingContent: '', progressMessage: '' })
        }
      },

      closeConversation: async (conversationId) => {
        try {
          await fetch(`/api/employee/conversations/${conversationId}`, {
            method: 'DELETE',
          })
          set((state) => ({
            conversations: state.conversations.filter((c) => c.id !== conversationId),
            activeConversationId:
              state.activeConversationId === conversationId ? null : state.activeConversationId,
            messages: state.activeConversationId === conversationId ? [] : state.messages,
            activeToolExecutions:
              state.activeConversationId === conversationId ? [] : state.activeToolExecutions,
          }))
        } catch {
          // noop
        }
      },
    }),
    {
      name: 'crewmeld-conversation',
      partialize: (state) => ({
        activeConversationId: state.activeConversationId,
      }),
    }
  )
)
