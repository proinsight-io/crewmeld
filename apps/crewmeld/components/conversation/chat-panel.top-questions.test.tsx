// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from './chat-panel'

const sendMessage = vi.fn().mockResolvedValue(undefined)
const loadMessages = vi.fn().mockResolvedValue(undefined)
const createConversation = vi.fn().mockResolvedValue('conversation-created')
let isStreaming = false

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/conversation/store', () => ({
  useConversationStore: () => ({
    messages: [],
    isStreaming,
    streamingContent: '',
    activeToolExecutions: [],
    progressMessage: '',
    loadMessages,
    sendMessage,
    createConversation,
  }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const datasets = [
  { id: 'dataset-1', knowledgeBaseId: 'local-kb-1', name: '锂电系列', type: 'document' as const },
  { id: 'dataset-2', knowledgeBaseId: 'local-kb-2', name: '24V 发电机', type: 'document' as const },
]

function response(data: unknown, ok = true) {
  return { ok, json: vi.fn().mockResolvedValue({ data }) } as unknown as Response
}

function installFetch(topQuestions: Record<string, unknown[]> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
    const top = Object.entries(topQuestions).find(([path]) => url.includes(path))
    return Promise.resolve(response(top?.[1] ?? []))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ChatPanel Top 3 questions', () => {
  beforeEach(() => {
    isStreaming = false
    sendMessage.mockReset().mockResolvedValue(undefined)
    loadMessages.mockReset().mockResolvedValue(undefined)
    createConversation.mockReset().mockResolvedValue('conversation-created')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('creates a new conversation before switching knowledge categories in an existing chat', async () => {
    installFetch()
    render(<ChatPanel conversationId='conversation-1' employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))

    await waitFor(() => expect(createConversation).toHaveBeenCalledWith('employee-1'))
    expect(screen.getByTestId('chat:knowledge:dataset-1')).toHaveAttribute('aria-pressed', 'true')
  })

  it('loads category Top 3 cards and sends a clicked card through the selected dataset', async () => {
    const fetchMock = installFetch({
      '/dataset-1/questions/top?topN=3': [
        { id: 'q1', question: '电池显示故障或离线', occurrenceCount: 4 },
        { id: 'q2', question: '电池如何充电？', occurrenceCount: 3 },
        { id: 'q3', question: '电池保养周期', occurrenceCount: 2 },
        { id: 'q4', question: '不应显示的第四个问题', occurrenceCount: 1 },
      ],
    })
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    expect(await screen.findByText('您可能想咨询以下问题')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '电池显示故障或离线' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '不应显示的第四个问题' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/employee/employees/employee-1/chat-knowledge-bases/dataset-1/questions/top?topN=3',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    fireEvent.click(screen.getByRole('button', { name: '电池显示故障或离线' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('电池显示故障或离线', 'employee-1', undefined, ['dataset-1'])
    )
  })

  it('keeps free text sending scoped to the selected dataset', async () => {
    installFetch()
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    fireEvent.change(screen.getByTestId('chat:input:message'), { target: { value: '自定义问题' } })
    fireEvent.click(screen.getByTestId('chat:send'))

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('自定义问题', 'employee-1', undefined, ['dataset-1'])
    )
  })

  it('sends a quick-question card exactly once when it is clicked rapidly', async () => {
    let resolveSend: (() => void) | undefined
    sendMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    installFetch({ '/dataset-1/questions/top?topN=3': [{ id: 'q1', question: '电池显示故障或离线' }] })
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    fireEvent.click(card)
    fireEvent.click(card)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(card).toBeDisabled()
    resolveSend?.()
    await waitFor(() => expect(card).not.toBeDisabled())
  })

  it('does not create two conversations during a rapid file-message double click and disables cards while creation is pending', async () => {
    createConversation.mockImplementation(() => new Promise<string>(() => undefined))
    installFetch({ '/dataset-1/questions/top?topN=3': [{ id: 'q1', question: '电池显示故障或离线' }] })
    const { container } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(fileInput!, { target: { files: [new File(['content'], 'manual.pdf')] } })
    fireEvent.change(screen.getByTestId('chat:input:message'), { target: { value: '请查看附件' } })
    fireEvent.click(screen.getByTestId('chat:send'))
    fireEvent.click(screen.getByTestId('chat:send'))

    expect(createConversation).toHaveBeenCalledTimes(1)
    expect(card).toBeDisabled()
    fireEvent.click(card)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('clears old cards immediately and prevents stale category responses from replacing the current cards', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('dataset-1')) return first
      if (url.includes('dataset-2')) return Promise.resolve(response([{ id: 'q2', question: '发电机无法启动' }]))
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    fireEvent.click(screen.getByTestId('chat:knowledge:dataset-2'))

    expect(screen.queryByText('电池显示故障或离线')).not.toBeInTheDocument()
    expect(await screen.findByText('发电机无法启动')).toBeInTheDocument()
    resolveFirst?.(response([{ id: 'q1', question: '电池显示故障或离线' }]))
    await waitFor(() => expect(screen.queryByText('电池显示故障或离线')).not.toBeInTheDocument())
  })

  it('hides Top 3 for all knowledge bases and makes no Top 3 request', async () => {
    const fetchMock = installFetch()
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    await screen.findByTestId('chat:knowledge:dataset-1')
    fireEvent.click(screen.getByTestId('chat:knowledge:all'))

    expect(screen.queryByText('您可能想咨询以下问题')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/questions/top'))).toBe(false)
  })

  it('clears the previous employee knowledge bases while the next employee is loading', async () => {
    let resolveNext: ((value: Response) => void) | undefined
    const next = new Promise<Response>((resolve) => {
      resolveNext = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/employees/employee-1/chat-knowledge-bases')) {
        return Promise.resolve(response([datasets[0]]))
      }
      if (url.endsWith('/employees/employee-2/chat-knowledge-bases')) return next
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    expect(await screen.findByTestId('chat:knowledge:dataset-1')).toBeInTheDocument()
    rerender(<ChatPanel conversationId={null} employeeId='employee-2' />)

    expect(screen.queryByTestId('chat:knowledge:dataset-1')).not.toBeInTheDocument()
    resolveNext?.(response([datasets[1]]))
    expect(await screen.findByTestId('chat:knowledge:dataset-2')).toBeInTheDocument()
  })

  it('does not let an older employee request write into the newer employee view', async () => {
    let resolvePrevious: ((value: Response) => void) | undefined
    const previous = new Promise<Response>((resolve) => {
      resolvePrevious = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/employees/employee-1/chat-knowledge-bases')) return previous
      if (url.endsWith('/employees/employee-2/chat-knowledge-bases')) {
        return Promise.resolve(response([datasets[1]]))
      }
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender(<ChatPanel conversationId={null} employeeId='employee-2' />)
    expect(await screen.findByTestId('chat:knowledge:dataset-2')).toBeInTheDocument()
    resolvePrevious?.(response([datasets[0]]))

    await waitFor(() =>
      expect(screen.queryByTestId('chat:knowledge:dataset-1')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('chat:knowledge:dataset-2')).toBeInTheDocument()
  })

  it('announces Top 3 loading state accessibly', async () => {
    const top = new Promise<Response>(() => undefined)
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) return top
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    expect(await screen.findByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('chat:top-questions')).toHaveAttribute('aria-busy', 'true')
  })

  it('shows an empty-state hint and leaves text input enabled', async () => {
    installFetch({ '/dataset-1/questions/top?topN=3': [] })
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    expect(await screen.findByText('暂无高频问题，您可以直接输入问题')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('chat:input:message')).not.toBeDisabled()
  })

  it('shows a retry action without disabling text input after a Top 3 request fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      return Promise.resolve(response([], false))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const retry = await screen.findByRole('button', { name: '重试' })
    expect(screen.getByRole('alert')).toHaveTextContent('高频问题加载失败')
    expect(screen.getByTestId('chat:input:message')).not.toBeDisabled()
    fireEvent.click(retry)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/questions/top'))).toHaveLength(2))
  })

  it('disables quick-question cards while streaming', async () => {
    isStreaming = true
    installFetch({ '/dataset-1/questions/top?topN=3': [{ id: 'q1', question: '电池显示故障或离线' }] })
    render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    expect(await screen.findByRole('button', { name: '电池显示故障或离线' })).toBeDisabled()
  })

  it('disables quick-question cards while a file upload is in progress', async () => {
    const upload = new Promise<Response>(() => undefined)
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/files/upload')) return upload
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, { target: { files: [new File(['content'], 'manual.pdf')] } })
    fireEvent.change(screen.getByTestId('chat:input:message'), { target: { value: '请查看附件' } })
    fireEvent.click(screen.getByTestId('chat:send'))

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/files/upload'))).toBe(true))
    expect(card).toBeDisabled()
  })

  it('disables cards until the current conversation service mode has initialized, then keeps them disabled for human service', async () => {
    let resolveMode: ((value: Response) => void) | undefined
    const mode = new Promise<Response>((resolve) => {
      resolveMode = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/conversations/conversation-1/events')) return mode
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel conversationId='conversation-1' employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    expect(card).toBeDisabled()
    expect(screen.getByTestId('chat:top-questions')).toHaveAttribute('aria-busy', 'false')
    resolveMode?.(response({ mode: 'human_service' }))
    await waitFor(() => expect(card).toBeDisabled())
    fireEvent.click(card)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('disables quick-question cards in human service mode', async () => {
    installFetch({ '/dataset-1/questions/top?topN=3': [{ id: 'q1', question: '电池显示故障或离线' }] })
    render(<ChatPanel conversationId='conversation-1' employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    fireEvent.click(screen.getByTestId('chat:service-mode-toggle'))

    await waitFor(() => expect(card).toBeDisabled())
    fireEvent.click(card)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('submits one service-mode change and disables cards while the POST is pending', async () => {
    const modeChange = new Promise<Response>(() => undefined)
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/conversations/conversation-1/events')) {
        return init?.method === 'POST' ? modeChange : Promise.resolve(response({ mode: 'ai' }))
      }
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel conversationId='conversation-1' employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    const toggle = screen.getByTestId('chat:service-mode-toggle')
    await waitFor(() => expect(toggle).not.toBeDisabled())
    fireEvent.click(toggle)
    fireEvent.click(toggle)

    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/events') && init?.method === 'POST')).toHaveLength(1)
    expect(toggle).toBeDisabled()
    expect(card).toBeDisabled()
    fireEvent.click(card)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('does not let an old service-mode POST change a newer conversation', async () => {
    let resolveModeChange: ((value: Response) => void) | undefined
    const modeChange = new Promise<Response>((resolve) => {
      resolveModeChange = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/conversations/conversation-1/events')) {
        return init?.method === 'POST' ? modeChange : Promise.resolve(response({ mode: 'ai' }))
      }
      if (url.includes('/conversations/conversation-2/events')) return Promise.resolve(response({ mode: 'ai' }))
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ChatPanel conversationId='conversation-1' employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    const toggle = screen.getByTestId('chat:service-mode-toggle')
    await waitFor(() => expect(toggle).not.toBeDisabled())
    fireEvent.click(toggle)
    rerender(<ChatPanel conversationId='conversation-2' employeeId='employee-1' />)
    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).not.toBeDisabled())
    resolveModeChange?.(response({ mode: 'human_service' }))

    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).toHaveTextContent('转人工客服'))
    expect(card).not.toBeDisabled()
  })

  it('keeps the mode switch locked when a new conversation prop adopts the conversation created for human service', async () => {
    let resolveConversation: ((value: string) => void) | undefined
    let resolveModeChange: ((value: Response) => void) | undefined
    createConversation.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveConversation = resolve
        })
    )
    const modeChange = new Promise<Response>((resolve) => {
      resolveModeChange = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/conversations/new-id/events')) {
        return init?.method === 'POST' ? modeChange : Promise.resolve(response({ mode: 'ai' }))
      }
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    const toggle = screen.getByTestId('chat:service-mode-toggle')
    fireEvent.click(toggle)
    expect(toggle).toBeDisabled()
    expect(card).toBeDisabled()

    resolveConversation?.('new-id')
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/events') && init?.method === 'POST')).toHaveLength(1))
    rerender(<ChatPanel conversationId='new-id' employeeId='employee-1' />)
    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).toBeDisabled())
    expect(card).toBeDisabled()
    fireEvent.click(screen.getByTestId('chat:service-mode-toggle'))
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/events') && init?.method === 'POST')).toHaveLength(1)

    resolveModeChange?.(response({ mode: 'human_service' }))
    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).toHaveTextContent('切回 AI'))
    expect(card).toBeDisabled()
  })

  it('invalidates a pending newly-created conversation mode switch after navigation to another conversation', async () => {
    let resolveModeChange: ((value: Response) => void) | undefined
    createConversation.mockResolvedValue('new-id')
    const modeChange = new Promise<Response>((resolve) => {
      resolveModeChange = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/chat-knowledge-bases')) return Promise.resolve(response(datasets))
      if (url.includes('/questions/top')) {
        return Promise.resolve(response([{ id: 'q1', question: '电池显示故障或离线' }]))
      }
      if (url.includes('/conversations/new-id/events')) {
        return init?.method === 'POST' ? modeChange : Promise.resolve(response({ mode: 'ai' }))
      }
      if (url.includes('/conversations/other-id/events')) return Promise.resolve(response({ mode: 'ai' }))
      return Promise.resolve(response([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ChatPanel conversationId={null} employeeId='employee-1' />)

    fireEvent.click(await screen.findByTestId('chat:knowledge:dataset-1'))
    const card = await screen.findByRole('button', { name: '电池显示故障或离线' })
    fireEvent.click(screen.getByTestId('chat:service-mode-toggle'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/events') && init?.method === 'POST')).toHaveLength(1))
    rerender(<ChatPanel conversationId='other-id' employeeId='employee-1' />)
    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).not.toBeDisabled())
    resolveModeChange?.(response({ mode: 'human_service' }))

    await waitFor(() => expect(screen.getByTestId('chat:service-mode-toggle')).toHaveTextContent('转人工客服'))
    expect(card).not.toBeDisabled()
  })
})
