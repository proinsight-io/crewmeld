/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPreviewMock, client, fetchMock } = vi.hoisted(() => ({
  getPreviewMock: vi.fn(),
  client: {
    isSandboxRunning: vi.fn(),
    getEndpoint: vi.fn(),
    proxyHeaders: vi.fn(),
  },
  fetchMock: vi.fn(),
}))

vi.mock('@/lib/dev-studio/service-preview-registry', () => ({
  getServicePreview: getPreviewMock,
}))
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  getOpenSandboxClient: () => client,
}))

const record = {
  previewId: 'preview-secret',
  userId: 'user-1',
  sessionId: 'session-1',
  executionId: 'execution-1',
  sandboxId: 'sandbox-1',
  port: 9876,
  servicePath: '/',
  expiresAt: '2099-08-22T00:00:00.000Z',
}

function context(path: string[] = []) {
  return {
    params: Promise.resolve({
      sessionId: 'session-1',
      previewId: 'preview-secret',
      path,
    }),
  }
}

describe('service preview route', () => {
  beforeEach(() => {
    getPreviewMock.mockReset().mockResolvedValue(record)
    client.isSandboxRunning.mockReset().mockResolvedValue(true)
    client.getEndpoint
      .mockReset()
      .mockResolvedValue('http://opensandbox:30080/sandboxes/sandbox-1/proxy/9876')
    client.proxyHeaders
      .mockReset()
      .mockReturnValue({ 'OPEN-SANDBOX-API-KEY': 'platform-secret' })
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('streams a relative asset through the capability without leaking platform details', async () => {
    fetchMock.mockResolvedValue(
      new Response('body { color: blue }', {
        status: 200,
        headers: { 'Content-Type': 'text/css', 'X-Upstream': 'ok' },
      })
    )
    const { GET } = await import('./route')

    const response = await GET(
      new Request(
        'http://localhost:6100/api/employee/dev-studio/sessions/session-1/preview/preview-secret/static/style.css?v=1'
      ),
      context(['static', 'style.css'])
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css')
    expect(await response.text()).toBe('body { color: blue }')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://opensandbox:30080/sandboxes/sandbox-1/proxy/9876/static/style.css?v=1',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    )
    expect(JSON.stringify([...response.headers])).not.toContain('platform-secret')
    expect(JSON.stringify([...response.headers])).not.toContain('opensandbox:30080')
  })

  it('forwards a POST body and status transparently', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = init.body ? await new Response(init.body).text() : ''
      expect(body).toBe('{"city":"Beijing"}')
      return new Response('{"ok":true}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const { POST } = await import('./route')

    const response = await POST(
      new Request(
        'http://localhost:6100/api/employee/dev-studio/sessions/session-1/preview/preview-secret/api/weather',
        { method: 'POST', body: '{"city":"Beijing"}' }
      ),
      context(['api', 'weather'])
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('returns 410 for an expired capability and 404 for a session mismatch', async () => {
    const { GET } = await import('./route')
    getPreviewMock.mockResolvedValueOnce(null)
    const expired = await GET(new Request('http://localhost/preview'), context())
    expect(expired.status).toBe(410)

    getPreviewMock.mockResolvedValueOnce({ ...record, sessionId: 'another-session' })
    const mismatch = await GET(new Request('http://localhost/preview'), context())
    expect(mismatch.status).toBe(404)
  })

  it('returns 502 when the retained sandbox has stopped', async () => {
    client.isSandboxRunning.mockResolvedValue(false)
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/preview'), context())

    expect(response.status).toBe(502)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
