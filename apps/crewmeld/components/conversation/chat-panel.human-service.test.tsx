// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from './chat-panel'

const loadMessages = vi.fn().mockResolvedValue(undefined)
const createConversation = vi.fn().mockResolvedValue('conversation-created')

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/conversation/store', () => ({
  useConversationStore: () => ({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    activeToolExecutions: [],
    progressMessage: '',
    loadMessages,
    sendMessage: vi.fn(),
    createConversation,
  }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

describe('ChatPanel human service mode', () => {
  beforeEach(() => {
    loadMessages.mockClear()
    createConversation.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const mode = init?.method === 'POST' ? 'human_service' : 'ai'
        return new Response(JSON.stringify({ success: true, data: { mode } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
    )
  })

  it('switches by posting the service_mode.changed event when the button is clicked', async () => {
    render(<ChatPanel conversationId='conversation-a' />)

    const toggle = await screen.findByTestId('chat:service-mode-toggle')
    expect(toggle).toHaveTextContent('转人工客服')
    fireEvent.click(toggle)

    await waitFor(() => expect(toggle).toHaveTextContent('切回 AI'))
    expect(fetch).toHaveBeenCalledWith('/api/employee/conversations/conversation-a/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'service_mode.changed', data: { mode: 'human' } }),
    })
  })
})
