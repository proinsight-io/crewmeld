/**
 * @vitest-environment node
 *
 * Sub-spec B: abort migrates from in-process `sessionRegistry` to the
 * DB-backed `sessionStore`. Auth + ownership rules mirror sibling routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'i',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
  }),
}))

const getEndpoint = vi.fn().mockResolvedValue('http://w')
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    getEndpoint = getEndpoint
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
  },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const VALID_RID = '11111111-1111-1111-1111-111111111111'
const SESSION_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = 'user-1'

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    status: 'active' as const,
    activeContainerId: 'sbx-1',
    containerStatus: 'running' as const,
    workspaceDir: '/tmp/ws',
    claudeStateDir: '/tmp/cl',
    ...overrides,
  }
}

function abortReq(body: Record<string, unknown> = { requestId: VALID_RID }): Request {
  return new Request('http://t', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions/:id/abort (Sub-spec B)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    getEndpoint.mockReset()
    getEndpoint.mockResolvedValue('http://w')
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: USER_ID,
      role: 'member',
      error: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValueOnce({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown sessionId', async () => {
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: 'nope' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to another user (no info leak)', async () => {
    storeGet.mockResolvedValueOnce(activeSession({ userId: 'other-user' }))
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 on malformed body', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const { POST } = await import('./route')
    const res = await POST(abortReq({}), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 when session has no active container', async () => {
    storeGet.mockResolvedValueOnce(
      activeSession({ activeContainerId: null, containerStatus: 'destroyed' })
    )
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(409)
  })

  it('forwards to webui abort using the resolved sandbox endpoint', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    )
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(200)
    expect(getEndpoint).toHaveBeenCalledWith('sbx-1', 8080)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://w/api/abort/${VALID_RID}`,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('passes through webui 404 (request id already done)', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(404)
  })

  it('returns 502 when webui fetch throws', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const { POST } = await import('./route')
    const res = await POST(abortReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(502)
  })
})
