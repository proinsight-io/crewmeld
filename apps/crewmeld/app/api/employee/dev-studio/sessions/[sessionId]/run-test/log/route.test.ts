/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/sessions/:sessionId/run-test/log.
 *
 * Boundaries mocked: auth + sessionStore + redis + opensandbox-client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const mockRedisGet = vi.fn()
vi.mock('@/lib/core/config/redis', () => ({
  getRedisClient: () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
  }),
}))

const mockExec = vi.fn()
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  getOpenSandboxClient: () => ({
    exec: (...args: unknown[]) => mockExec(...args),
  }),
}))

const CTX = { params: Promise.resolve({ sessionId: 's1' }) }

function makeReq(params: Record<string, string> = {}): Request {
  const url = new URL('http://test/api/employee/dev-studio/sessions/s1/run-test/log')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return new Request(url.toString(), { method: 'GET' })
}

function authedOwner(): void {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
  storeGet.mockResolvedValue({
    id: 's1',
    userId: 'user-1',
    status: 'active',
    workspaceDir: '/ws/s1',
  })
}

describe('GET /api/employee/dev-studio/sessions/:sessionId/run-test/log', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    mockRedisGet.mockReset()
    mockExec.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(makeReq({ sandboxId: 'sbx-1' }), CTX)
    expect(res.status).toBe(401)
  })

  it('returns 404 when session not found', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(makeReq({ sandboxId: 'sbx-1' }), CTX)
    expect(res.status).toBe(404)
  })

  it('returns 400 when sandboxId is missing', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(makeReq(), CTX)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing-sandbox-id')
  })

  it('returns 410 when retain window has expired', async () => {
    authedOwner()
    mockRedisGet.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(makeReq({ sandboxId: 'sbx-expired' }), CTX)
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('retain-expired')
  })

  it('returns 200 with log text on success', async () => {
    authedOwner()
    mockRedisGet.mockResolvedValue('2025-01-01T00:00:00.000Z')
    mockExec.mockResolvedValue({
      stdout: 'line1\nline2\nline3\n',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    })
    const { GET } = await import('./route')
    const res = await GET(makeReq({ sandboxId: 'sbx-1', lines: '50' }), CTX)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const text = await res.text()
    expect(text).toBe('line1\nline2\nline3\n')
    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'sbx-1' })
    )
  })
})
