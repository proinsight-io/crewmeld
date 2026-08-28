/**
 * @vitest-environment node
 *
 * BFF SSE proxy route for opencode /global/event stream.
 * Verified behaviors:
 *  - opencode session → 200 text/event-stream (upstream piped)
 *  - claudecode session → 409 (no SSE transport on claudecode)
 *  - missing session → 404
 *  - no activeContainerId → 502
 *  - upstream not-ok → 502
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    OPENSANDBOX_USE_PROXY: false,
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_PORT: 4096,
  }),
}))

const getEndpoint = vi.fn()
const proxyHeaders = vi.fn().mockReturnValue({})
const isSandboxRunning = vi.fn()

vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    getEndpoint = getEndpoint
    proxyHeaders = proxyHeaders
    isSandboxRunning = isSandboxRunning
  },
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn()

vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))

/** Minimal NextRequest-compatible mock. */
function makeReq(): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/events', {
    method: 'GET',
  })
}

/** One-frame SSE ReadableStream that closes after enqueue. */
function sseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: message\ndata: {}\n\n'))
      c.close()
    },
  })
}

describe('GET /api/employee/dev-studio/sessions/:sessionId/events', () => {
  beforeEach(() => {
    vi.resetModules()
    storeGet.mockReset()
    storeUpdate.mockReset()
    storeUpdate.mockResolvedValue(undefined)
    getEndpoint.mockReset()
    isSandboxRunning.mockReset()
    proxyHeaders.mockReset()
    proxyHeaders.mockReturnValue({})
  })

  it('GET proxies opencode SSE for opencode sessions', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-1',
    })
    getEndpoint.mockResolvedValue('http://h:4096')

    const upstreamResponse = new Response(sseStream(), { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstreamResponse)

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/global/event'),
      expect.objectContaining({ headers: expect.any(Object) }),
    )

    fetchSpy.mockRestore()
  })

  it('GET 409 for claudecode sessions (no SSE transport)', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'claudecode',
      activeContainerId: 'sbx-1',
    })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(409)
  })

  it('returns 404 when session not found', async () => {
    storeGet.mockResolvedValue(null)

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(404)
  })

  it('returns 502 when session has no activeContainerId', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: null,
    })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(502)
  })

  it('returns 502 when getEndpoint throws', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-1',
    })
    getEndpoint.mockRejectedValueOnce(new Error('unreachable'))

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(502)
  })

  it('returns 502 when upstream SSE returns non-ok status', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-1',
    })
    getEndpoint.mockResolvedValue('http://h:4096')
    // A non-404 error is retried MAX_ATTEMPTS times before giving up; mock every
    // attempt (not just the first) and drive the 1s backoff sleeps with fake
    // timers so the test completes instantly instead of racing the 10s timeout.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Bad Gateway', { status: 502 }))

    const { GET } = await import('./route')
    vi.useFakeTimers()
    const resPromise = GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    await vi.runAllTimersAsync()
    const res = await resPromise
    vi.useRealTimers()

    expect(res.status).toBe(502)
    fetchSpy.mockRestore()
  })

  it('returns 502 when upstream fetch throws a connection error', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-1',
    })
    getEndpoint.mockResolvedValue('http://h:4096')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const { GET } = await import('./route')
    vi.useFakeTimers()
    const resPromise = GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    await vi.runAllTimersAsync()
    const res = await resPromise
    vi.useRealTimers()

    expect(res.status).toBe(502)
    fetchSpy.mockRestore()
  })

  it('demotes the session and returns 410 when the sandbox is gone (upstream 404)', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-dead',
    })
    getEndpoint.mockResolvedValue('http://h:4096')
    // /global/event 404 means the sandbox itself is gone; confirm not-running.
    isSandboxRunning.mockResolvedValue(false)

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Not Found', { status: 404 }))

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(410)
    expect(isSandboxRunning).toHaveBeenCalledWith('sbx-dead')
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
    // 404 is terminal — the retry loop must not spin the full 10 attempts.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })

  it('does NOT demote on upstream 404 when the sandbox is still running', async () => {
    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-live',
    })
    getEndpoint.mockResolvedValue('http://h:4096')
    // Container is alive; a 404 here is not a dead sandbox — leave the row alone.
    isSandboxRunning.mockResolvedValue(true)

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Not Found', { status: 404 }))

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(502)
    expect(storeUpdate).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('includes auth_token query param when password is set', async () => {
    vi.resetModules()
    vi.mock('@/lib/dev-studio/env', () => ({
      getDevStudioEnv: () => ({
        OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
        OPENSANDBOX_API_KEY: 'k',
        OPENSANDBOX_USE_PROXY: false,
        OPENCODE_SERVER_PASSWORD: 'secret',
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_PORT: 4096,
      }),
    }))

    storeGet.mockResolvedValue({
      id: 's1',
      coderType: 'opencode',
      activeContainerId: 'sbx-1',
    })
    getEndpoint.mockResolvedValue('http://h:4096')

    const upstreamResponse = new Response(sseStream(), { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstreamResponse)

    const { GET } = await import('./route')
    const res = await GET(makeReq(), { params: Promise.resolve({ sessionId: 's1' }) })

    expect(res.status).toBe(200)
    const fetchUrl = fetchSpy.mock.calls[0][0] as string
    expect(fetchUrl).toContain('auth_token=')

    fetchSpy.mockRestore()
  })
})
