/**
 * @vitest-environment node
 *
 * Tests for POST /api/employee/dev-studio/sessions/:sessionId/dependencies/reject.
 *
 * Rejection queues a system note describing what the user rejected (plus an
 * optional free-form `note`) so the AI sees it as in-band guidance on its next
 * turn. It does NOT modify the manifest or approvedDependencies. Returns 204.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const queueSystemNote = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    queueSystemNote: (...args: unknown[]) => queueSystemNote(...args),
  },
}))

function authedOwner() {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
  storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active' })
}

function rejectReq(body: unknown): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/dependencies/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('POST /sessions/:sessionId/dependencies/reject', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    queueSystemNote.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    expect((await POST(rejectReq({ libraries: ['x'] }), ctx)).status).toBe(401)
    expect(queueSystemNote).not.toHaveBeenCalled()
  })

  it('returns 404 cross-user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { POST } = await import('./route')
    expect((await POST(rejectReq({ libraries: ['x'] }), ctx)).status).toBe(404)
  })

  it('returns 400 when nothing to reject (both arrays empty/absent)', async () => {
    authedOwner()
    const { POST } = await import('./route')
    expect((await POST(rejectReq({}), ctx)).status).toBe(400)
    expect(queueSystemNote).not.toHaveBeenCalled()
  })

  it('queues a system note describing the rejection (libraries + domains + note)', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(
      rejectReq({ libraries: ['lxml'], domains: ['evil.com'], note: '换 stdlib' }),
      ctx
    )
    expect(res.status).toBe(204)
    expect(queueSystemNote).toHaveBeenCalledTimes(1)
    const [sid, msg] = queueSystemNote.mock.calls[0]
    expect(sid).toBe('s1')
    expect(msg).toContain('库: lxml')
    expect(msg).toContain('域名: evil.com')
    expect(msg).toContain('原因：换 stdlib')
    expect(msg).toContain('换其他方案')
  })

  it('returns 400 when note exceeds the 500-char cap', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(rejectReq({ libraries: ['x'], note: 'a'.repeat(501) }), ctx)
    expect(res.status).toBe(400)
    expect(queueSystemNote).not.toHaveBeenCalled()
  })

  it('accepts ips-only rejection and includes them in the note', async () => {
  authedOwner()
  const { POST } = await import('./route')
  const req = rejectReq({ ips: ['10.0.0.5'] })
  const res = await POST(req, ctx)
  expect(res.status).toBe(204)
  expect(queueSystemNote).toHaveBeenCalledWith('s1',expect.stringContaining('10.0.0.5'))
  })
})
