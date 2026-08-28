/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../../lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'i',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    CREWMELD_SESSIONS_DIR: 'D:/tmp/test-sessions',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'http://anthropic',
    ANTHROPIC_MODEL: 'm',
  }),
}))

const rmMock = vi.fn().mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  rm: (path: string, opts: { recursive: boolean; force: boolean }) => rmMock(path, opts),
}))

const destroy = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../../../../lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    destroy = destroy
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn()
vi.mock('../../../../../../lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))

describe('GET /api/employee/dev-studio/sessions/:sessionId', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 when session does not exist', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/missing'), {
      params: Promise.resolve({ sessionId: 'missing' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to a different user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other-user', status: 'active' })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns the session payload when owned by the caller', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    const row = { id: 's1', userId: 'user-1', status: 'active', title: 'demo' }
    storeGet.mockResolvedValue(row)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: unknown }
    expect(body.session).toEqual(row)
    expect(storeGet).toHaveBeenCalledWith('s1')
  })
})

describe('PATCH /api/employee/dev-studio/sessions/:sessionId', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
  })

  function patchReq(body: unknown): Request {
    return new Request('http://test/api/employee/dev-studio/sessions/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ rightPanelVisible: true }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  it('returns 404 when session is not owned by caller', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ rightPanelVisible: true }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for unknown fields (strict)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ title: 'nope', evilField: 1 }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when rightPanelVisible is not a boolean', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ rightPanelVisible: 'yes' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  it('applies rightPanelVisible patch and returns updated row', async () => {
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
      rightPanelVisible: false,
    })
    storeUpdate.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'active',
      rightPanelVisible: true,
    })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ rightPanelVisible: true }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { rightPanelVisible: boolean } }
    expect(body.session.rightPanelVisible).toBe(true)
    expect(storeUpdate).toHaveBeenCalledWith('s1', { rightPanelVisible: true })
  })

  it('persists title when the session has no title yet (first naming)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active', title: null })
    storeUpdate.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active', title: '排班助手' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ title: '排班助手' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', { title: '排班助手' })
  })

  it('does NOT overwrite an existing title (first-naming only) and skips a no-op update', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active', title: '已命名' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ title: '新名字' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { title: string } }
    expect(body.session.title).toBe('已命名')
    expect(storeUpdate).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/employee/dev-studio/sessions/:sessionId', () => {
  beforeEach(() => {
    destroy.mockClear()
    rmMock.mockClear()
    storeGet.mockReset()
    mockGetCurrentUserRole.mockReset()
    destroy.mockResolvedValue(undefined)
    rmMock.mockResolvedValue(undefined)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it('returns 404 when session is missing or not owned by caller', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValueOnce(null)
    const { DELETE } = await import('./route')
    let res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/nope', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 'nope' }) }
    )
    expect(res.status).toBe(404)
    expect(destroy).not.toHaveBeenCalled()

    storeGet.mockResolvedValueOnce({ id: 's1', userId: 'other', status: 'active' })
    res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(404)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('physically deletes the row, destroys the container, and removes the workspace when no tool is linked', async () => {
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
      toolId: null,
      activeContainerId: 'sbx-1',
    })
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
    expect(destroy).toHaveBeenCalledWith('sbx-1')
    // No linked tool → the host workspace is removed with the session.
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it('preserves the workspace when the session is linked to a tool', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'adopted',
      toolId: 'tool-1',
      activeContainerId: 'sbx-1',
    })
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
    expect(destroy).toHaveBeenCalledWith('sbx-1')
    // Linked tool owns the workspace → must NOT be removed.
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('skips container destroy when activeContainerId is null', async () => {
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
      toolId: null,
      activeContainerId: null,
    })
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
    expect(destroy).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it('still returns 204 if OpenSandbox destroy throws', async () => {
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
      toolId: null,
      activeContainerId: 'sbx-1',
    })
    destroy.mockRejectedValueOnce(new Error('boom'))
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request('http://test/api/employee/dev-studio/sessions/s1', { method: 'DELETE' }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
  })
})
