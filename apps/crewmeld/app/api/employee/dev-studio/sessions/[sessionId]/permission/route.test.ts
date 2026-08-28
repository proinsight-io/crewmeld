/**
 * @vitest-environment node
 *
 * Task 10: permission route — relays permission replies to opencode via
 * replyOpencodePermission. Only wires to opencode sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'i',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    OPENCODE_SERVER_PASSWORD: 'pw',
    OPENCODE_SERVER_USERNAME: 'opencode',
  }),
}))

const replyPermissionMock = vi.fn()
vi.mock('@/lib/dev-studio/opencode-rest', () => ({
  replyOpencodePermission: (...args: unknown[]) => replyPermissionMock(...args),
}))

vi.mock('@/lib/dev-studio/coder-providers', () => ({
  getCoderProvider: (_type: string) => ({
    id: 'opencode',
    port: 4096,
    authHeader: (_env: unknown) => ({ Authorization: 'Basic dGVzdA==' }),
  }),
}))

const getEndpoint = vi.fn().mockResolvedValue('http://w')
const proxyHeaders = vi.fn().mockReturnValue({})
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    getEndpoint = getEndpoint
    proxyHeaders = proxyHeaders
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

const SESSION_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = 'user-perm'

function opencodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    coderType: 'opencode' as const,
    activeContainerId: 'sbx-perm',
    opencodeSessionId: 'oc_ses_1',
    ...overrides,
  }
}

function permReq(body: Record<string, unknown> = {}): Request {
  return new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'req_abc', reply: 'once', ...body }),
  })
}

describe('POST /sessions/:id/permission', () => {
  beforeEach(() => {
    replyPermissionMock.mockReset()
    replyPermissionMock.mockResolvedValue(undefined)
    getEndpoint.mockClear()
    getEndpoint.mockResolvedValue('http://w')
    proxyHeaders.mockClear()
    proxyHeaders.mockReturnValue({})
    storeGet.mockReset()
    mockGetCurrentUserRole.mockReset()
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
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 when session not found', async () => {
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to another user', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ userId: 'other' }))
    const { POST } = await import('./route')
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session is not an opencode session', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ coderType: 'claudecode' }))
    const { POST } = await import('./route')
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 502 when activeContainerId is null', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ activeContainerId: null }))
    const { POST } = await import('./route')
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(502)
  })

  it('returns 400 on invalid body (missing requestId)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(
      permReq({ requestId: '' }),
      { params: Promise.resolve({ sessionId: SESSION_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on invalid reply value', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(
      permReq({ reply: 'invalid' }),
      { params: Promise.resolve({ sessionId: SESSION_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('calls replyOpencodePermission and returns 200 on success', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(permReq({ requestId: 'req_xyz', reply: 'always' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(replyPermissionMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'req_xyz',
      'always',
    )
  })

  it('accepts reply: reject', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(permReq({ reply: 'reject' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    expect(replyPermissionMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'req_abc',
      'reject',
    )
  })

  it('returns 502 when getEndpoint throws (sandbox unreachable)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    getEndpoint.mockRejectedValueOnce(new Error('timeout'))
    const { POST } = await import('./route')
    const res = await POST(permReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(502)
    expect(replyPermissionMock).not.toHaveBeenCalled()
  })
})
