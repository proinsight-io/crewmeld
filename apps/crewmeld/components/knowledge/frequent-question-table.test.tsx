/** @vitest-environment jsdom */

import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator,
})

let render: typeof import('@testing-library/react').render
let fireEvent: typeof import('@testing-library/react').fireEvent
let cleanup: typeof import('@testing-library/react').cleanup
let waitFor: typeof import('@testing-library/react').waitFor
let FrequentQuestionTable: typeof import('./frequent-question-table').FrequentQuestionTable

const topQuestions = [
  {
    id: 'question-1',
    knowledgeBaseId: 'local-kb-1',
    question: '电池离线怎么办？',
    occurrenceCount: 12,
    lastSeenAt: '2026-08-03T08:30:00.000Z',
    status: 'pending',
  },
  {
    id: 'question-2',
    knowledgeBaseId: 'local-kb-1',
    question: '充电需要多久？',
    occurrenceCount: 8,
    lastSeenAt: '2026-08-02T08:30:00.000Z',
    status: 'promoted',
  },
  {
    id: 'question-3',
    knowledgeBaseId: 'local-kb-1',
    question: '如何保养电池？',
    occurrenceCount: 5,
    lastSeenAt: '2026-08-01T08:30:00.000Z',
    status: 'pending',
  },
]

function response(body: unknown, ok = true) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 500 }))
}

function setupFetch(options: {
  datasets?: Array<{ id: string; name: string; type?: 'document' | 'qa'; metadata: { id: string } }>
  top?: unknown
  topHandler?: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const datasets = options.datasets ?? [
    { id: 'dataset-1', name: '电池知识库', metadata: { id: 'local-kb-1' } },
  ]
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/employee/ragflow/datasets?pageSize=50') return response({ data: datasets })
    if (url.startsWith('/api/employee/knowledge/question-analytics?')) {
      return response({ success: true, data: [], pagination: { total: 0 } })
    }
    if (url.includes('/questions/top?topN=3')) {
      return options.topHandler?.(url, init) ?? response({ success: true, data: options.top ?? topQuestions })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function topRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/questions/top?topN=3'))
}

beforeAll(async () => {
  ;({ render, fireEvent, cleanup, waitFor } = await import('@testing-library/react'))
  ;({ FrequentQuestionTable } = await import('./frequent-question-table'))
})

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FrequentQuestionTable Top 3 preview', () => {
  it('gives the category selector an accessible name', async () => {
    setupFetch({})
    const view = render(<FrequentQuestionTable />)

    expect(await view.findByRole('combobox', { name: '高频问题分类' })).toBeInTheDocument()
  })

  it('loads and displays top three when a concrete category is selected', async () => {
    const fetchMock = setupFetch({})
    const view = render(<FrequentQuestionTable />)

    fireEvent.change(await view.findByTestId('knowledge:frequent:category'), {
      target: { value: 'local-kb-1' },
    })

    expect(await view.findByText('当前分类 Top 3')).toBeInTheDocument()
    expect(view.getByText(/电池离线怎么办？/)).toBeInTheDocument()
    expect(view.getByText(/12 次/)).toBeInTheDocument()
    expect(view.getAllByText(/最近出现：/)).toHaveLength(3)
    expect(topRequests(fetchMock)).toHaveLength(1)
    expect(topRequests(fetchMock)[0]?.[0]).toBe(
      '/api/employee/knowledge/local-kb-1/questions/top?topN=3'
    )
  })

  it('hides the preview and does not load Top 3 for all categories or other', async () => {
    const fetchMock = setupFetch({})
    const view = render(<FrequentQuestionTable />)
    const category = await view.findByTestId('knowledge:frequent:category')

    fireEvent.change(category, { target: { value: 'local-kb-1' } })
    await view.findByText('当前分类 Top 3')
    fireEvent.change(category, { target: { value: '' } })
    expect(view.queryByText('当前分类 Top 3')).not.toBeInTheDocument()
    fireEvent.change(category, { target: { value: 'other' } })
    expect(view.queryByText('当前分类 Top 3')).not.toBeInTheDocument()
    expect(topRequests(fetchMock)).toHaveLength(1)
  })

  it('shows an empty state when the selected category has no frequent questions', async () => {
    setupFetch({ top: [] })
    const view = render(<FrequentQuestionTable />)

    fireEvent.change(await view.findByTestId('knowledge:frequent:category'), {
      target: { value: 'local-kb-1' },
    })

    await waitFor(() =>
      expect(view.getByRole('status')).toHaveTextContent('当前分类暂无高频问题')
    )
    const emptyState = view.getByRole('status')
    expect(emptyState).toHaveAttribute('aria-live', 'polite')
  })

  it('keeps the main table visible when the preview request fails', async () => {
    setupFetch({ topHandler: () => response({ error: '预览服务不可用' }, false) })
    const view = render(<FrequentQuestionTable />)

    fireEvent.change(await view.findByTestId('knowledge:frequent:category'), {
      target: { value: 'local-kb-1' },
    })

    expect(await view.findByRole('alert')).toHaveTextContent('预览服务不可用')
    expect(view.getByText('暂无用户问题')).toBeInTheDocument()
  })

  it('announces loading politely while the selected category preview is pending', async () => {
    let resolveTop: ((value: Response) => void) | undefined
    const top = new Promise<Response>((resolve) => {
      resolveTop = resolve
    })
    setupFetch({ topHandler: () => top })
    const view = render(<FrequentQuestionTable />)

    fireEvent.change(await view.findByTestId('knowledge:frequent:category'), {
      target: { value: 'local-kb-1' },
    })

    const loadingState = await view.findByRole('status')
    expect(loadingState).toHaveAttribute('aria-live', 'polite')
    expect(loadingState).toHaveTextContent('加载中…')
    resolveTop?.(new Response(JSON.stringify({ success: true, data: [] })))
  })

  it('aborts a pending preview on unmount without logging a React update error', async () => {
    let resolveTop: ((value: Response) => void) | undefined
    const top = new Promise<Response>((resolve) => {
      resolveTop = resolve
    })
    const fetchMock = setupFetch({ topHandler: () => top })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<FrequentQuestionTable />)

    fireEvent.change(await view.findByTestId('knowledge:frequent:category'), {
      target: { value: 'local-kb-1' },
    })
    await waitFor(() => expect(topRequests(fetchMock)).toHaveLength(1))
    const signal = topRequests(fetchMock)[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    view.unmount()
    expect(signal.aborted).toBe(true)
    resolveTop?.(new Response(JSON.stringify({ success: true, data: topQuestions })))
    await Promise.resolve()
    await Promise.resolve()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not allow an older category response to replace the current preview', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    let resolveSecond: ((value: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve
    })
    setupFetch({
      datasets: [
        { id: 'dataset-1', name: '电池知识库', metadata: { id: 'local-kb-1' } },
        { id: 'dataset-2', name: '发电机知识库', metadata: { id: 'local-kb-2' } },
      ],
      topHandler: (url) => (url.includes('local-kb-1') ? first : second),
    })
    const view = render(<FrequentQuestionTable />)
    const category = await view.findByTestId('knowledge:frequent:category')

    fireEvent.change(category, { target: { value: 'local-kb-1' } })
    await waitFor(() => expect(resolveFirst).toBeDefined())
    fireEvent.change(category, { target: { value: 'local-kb-2' } })
    await waitFor(() => expect(resolveSecond).toBeDefined())

    resolveSecond?.(new Response(JSON.stringify({ success: true, data: [{ ...topQuestions[0], question: '发电机如何启动？' }] })))
    expect(await view.findByText(/发电机如何启动？/)).toBeInTheDocument()
    resolveFirst?.(new Response(JSON.stringify({ success: true, data: topQuestions })))

    await waitFor(() => expect(view.queryByText(/电池离线怎么办？/)).not.toBeInTheDocument())
    expect(view.getByText(/发电机如何启动？/)).toBeInTheDocument()
  })
})
