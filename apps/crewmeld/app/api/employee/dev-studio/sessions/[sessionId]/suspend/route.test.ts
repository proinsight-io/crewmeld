/**
 * @vitest-environment node
 *
 * Tests for POST /sessions/:sessionId/suspend — the implicit-background
 * teardown fired when the operator navigates away. Verifies the key invariant:
 * in-progress work is preserved (suspend, not delete), while empty abandoned
 * sessions are purged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
  }),
}))

const destroy = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    destroy = destroy
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeSuspend = vi.fn()
const storeHasUserMessages = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    suspend: (...args: unknown[]) => storeSuspend(...args),
    hasUserMessages: (...args: unknown[]) => storeHasUserMessages(...args),
  },
}))

const purgeSession = vi.fn()
vi.mock('@/lib/dev-studio/session-teardown', () => ({
  purgeSession: (...args: unknown[]) => purgeSession(...args),
}))

function authed() {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
}

function suspendReq(): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/suspend', {
    method: 'POST',
  })
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('POST /sessions/:sessionId/suspend', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeSuspend.mockReset().mockResolvedValue(undefined)
    storeHasUserMessages.mockReset().mockResolvedValue(false)
    purgeSession.mockReset().mockResolvedValue(undefined)
    destroy.mockClear().mockResolvedValue(undefined)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 when the session is missing or owned by another user', async () => {
    authed()
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    let res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(404)

    storeGet.mockResolvedValueOnce({ id: 's1', userId: 'other', status: 'active' })
    res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(404)
    expect(storeSuspend).not.toHaveBeenCalled()
    expect(purgeSession).not.toHaveBeenCalled()
  })

  it('no-ops (204) for a non-active session without touching it', async () => {
    authed()
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'adopted', toolId: 't1' })
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(storeSuspend).not.toHaveBeenCalled()
    expect(purgeSession).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it('purges an empty, never-adopted session instead of keeping it', async () => {
    authed()
    const session = {
      id: 's1',
      userId: 'user-1',
      status: 'active',
      toolId: null,
      activeContainerId: 'sbx-1',
    }
    storeGet.mockResolvedValue(session)
    storeHasUserMessages.mockResolvedValue(false)
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(purgeSession).toHaveBeenCalledWith(session)
    expect(storeSuspend).not.toHaveBeenCalled()
  })

  it('suspends (preserves) a session that has operator messages', async () => {
    authed()
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'active',
      toolId: null,
      activeContainerId: 'sbx-1',
    })
    storeHasUserMessages.mockResolvedValue(true)
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(purgeSession).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledWith('sbx-1')
    expect(storeSuspend).toHaveBeenCalledWith('s1')
  })

  it('treats a tool-linked session as work and suspends it without checking messages', async () => {
    authed()
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'active',
      toolId: 'tool-1',
      activeContainerId: 'sbx-1',
    })
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(storeHasUserMessages).not.toHaveBeenCalled()
    expect(purgeSession).not.toHaveBeenCalled()
    expect(storeSuspend).toHaveBeenCalledWith('s1')
  })

  it('suspends without a container destroy when none is running', async () => {
    authed()
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'active',
      toolId: null,
      activeContainerId: null,
    })
    storeHasUserMessages.mockResolvedValue(true)
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(destroy).not.toHaveBeenCalled()
    expect(storeSuspend).toHaveBeenCalledWith('s1')
  })

  it('still suspends if the container destroy throws', async () => {
    authed()
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'active',
      toolId: null,
      activeContainerId: 'sbx-1',
    })
    storeHasUserMessages.mockResolvedValue(true)
    destroy.mockRejectedValueOnce(new Error('boom'))
    const { POST } = await import('./route')
    const res = await POST(suspendReq(), ctx)
    expect(res.status).toBe(204)
    expect(storeSuspend).toHaveBeenCalledWith('s1')
  })
})
