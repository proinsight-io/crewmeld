/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `paths` reads CREWMELD_BFF_VOLUME_ROOT / CREWMELD_SANDBOX_VOLUME_ROOT
// directly from process.env, so the test mocks it via env vars.
process.env.CREWMELD_BFF_VOLUME_ROOT = 'D:/tmp/test-volume'
process.env.CREWMELD_SANDBOX_VOLUME_ROOT = '/data/test-volume'

vi.mock('../../../../../../../lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'crewmeld/dev-sandbox:latest',
    CREWMELD_OPENCODE_IMAGE: 'proinsight/crewmeld-coder2:latest',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    CREWMELD_SESSIONS_DIR: 'D:/tmp/test-sessions',
    CREWMELD_BFF_VOLUME_ROOT: 'D:/tmp/test-volume',
    CREWMELD_SANDBOX_VOLUME_ROOT: '/data/test-volume',
    CREWMELD_SANDBOX_CPU: '1000m',
    CREWMELD_SANDBOX_MEMORY: '2Gi',
    CREWMELD_PIP_INDEX_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'http://anthropic',
    ANTHROPIC_MODEL: 'qianfan-code-latest',
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_PORT: 4096,
  }),
}))

const createSandbox = vi.fn()
const waitUntilRunning = vi.fn()
const getEndpoint = vi.fn()
const destroy = vi.fn()
const isSandboxRunning = vi.fn()

vi.mock('../../../../../../../lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    createSandbox = createSandbox
    waitUntilRunning = waitUntilRunning
    getEndpoint = getEndpoint
    destroy = destroy
    isSandboxRunning = isSandboxRunning
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn()
const storeList = vi.fn()
vi.mock('../../../../../../../lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
    list: (...args: unknown[]) => storeList(...args),
  },
}))

describe('POST /api/employee/dev-studio/sessions/:sessionId/rehydrate', () => {
  beforeEach(() => {
    createSandbox.mockReset()
    waitUntilRunning.mockReset()
    getEndpoint.mockReset()
    destroy.mockReset()
    isSandboxRunning.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
    storeList.mockReset()
    mockGetCurrentUserRole.mockReset()
    storeUpdate.mockResolvedValue(undefined)
    // Default: no other running sessions for the user (pre-flight no-op).
    storeList.mockResolvedValue([])
    // Default no-op for destroy so handlers can call .catch() on the result.
    destroy.mockResolvedValue(undefined)
  })

  function rehydrateReq(): Request {
    return new Request('http://test/api/employee/dev-studio/sessions/s1/rehydrate', {
      method: 'POST',
    })
  }

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('returns 404 when session is missing or not owned by caller', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    let res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(404)

    storeGet.mockResolvedValueOnce({ id: 's1', userId: 'other', status: 'active' })
    res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 410 Gone when session status is not active', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'user-1',
      status: 'archived',
      activeContainerId: null,
      workspaceDir: '/tmp/ws',
      claudeStateDir: '/tmp/cl',
    })
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(410)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('returns alive=true when activeContainerId still resolves an endpoint', async () => {
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
      activeContainerId: 'sbx-existing',
      workspaceDir: '/tmp/ws',
      claudeStateDir: '/tmp/cl',
    })
    isSandboxRunning.mockResolvedValue(true)
    getEndpoint.mockResolvedValue('http://opensandbox:34567')
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; alive: boolean }
    expect(body.endpoint).toBe('http://opensandbox:34567')
    expect(body.alive).toBe(true)
    expect(isSandboxRunning).toHaveBeenCalledWith('sbx-existing')
    expect(getEndpoint).toHaveBeenCalledWith('sbx-existing', 8080)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('recreates container when activeContainerId is null', async () => {
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
      activeContainerId: null,
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    createSandbox.mockResolvedValue({ id: 'sbx-new' })
    waitUntilRunning.mockResolvedValue(undefined)
    getEndpoint.mockResolvedValue('http://opensandbox:55555')
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; alive: boolean }
    expect(body.endpoint).toBe('http://opensandbox:55555')
    expect(body.alive).toBe(false)
    // Sandbox volumes use the forSandbox() (Linux-style) paths so OpenSandbox
    // running on Ubuntu sees the same physical NFS data as the BFF — NOT the
    // BFF-side `session.workspaceDir` / `session.claudeStateDir` columns.
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        volumes: expect.arrayContaining([
          expect.objectContaining({
            hostPath: '/data/test-volume/sessions/s1/workspace',
            mountPath: '/root/workspace',
          }),
          expect.objectContaining({
            hostPath: '/data/test-volume/sessions/s1/claude',
            mountPath: '/root/.claude/projects',
          }),
        ]),
      })
    )
    // Workspace + claude/projects subtree only — rest of /root/.claude is
    // owned by the image.
    const callArgs = createSandbox.mock.calls[0][0] as { volumes: unknown[] }
    expect(callArgs.volumes).toHaveLength(2)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        activeContainerId: 'sbx-new',
        containerStatus: 'running',
      })
    )
  })

  it('suspends another running session before claiming running', async () => {
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
      activeContainerId: null,
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    // A stale sibling session still reads `running` (container long dead).
    storeList.mockResolvedValue([
      {
        id: 's-other',
        userId: 'user-1',
        status: 'active',
        containerStatus: 'running',
        activeContainerId: 'sbx-other',
      },
      {
        id: 's1',
        userId: 'user-1',
        status: 'active',
        containerStatus: 'destroyed',
        activeContainerId: null,
      },
    ])
    createSandbox.mockResolvedValue({ id: 'sbx-new' })
    waitUntilRunning.mockResolvedValue(undefined)
    getEndpoint.mockResolvedValue('http://opensandbox:55555')
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(200)
    // Orphan container torn down + sibling row demoted to free the unique index.
    expect(destroy).toHaveBeenCalledWith('sbx-other')
    expect(storeUpdate).toHaveBeenCalledWith(
      's-other',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
    // Then this session is promoted to running.
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ activeContainerId: 'sbx-new', containerStatus: 'running' })
    )
  })

  it('recreates container when activeContainerId is set but the sandbox is not running', async () => {
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
      activeContainerId: 'sbx-dead',
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    // In proxy mode the probe MUST consult isSandboxRunning (getEndpoint would
    // wrongly succeed for a dead box); a reaped container reports not-running.
    isSandboxRunning.mockResolvedValue(false)
    createSandbox.mockResolvedValue({ id: 'sbx-fresh' })
    waitUntilRunning.mockResolvedValue(undefined)
    getEndpoint.mockResolvedValueOnce('http://opensandbox:99999')
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; alive: boolean }
    expect(body.alive).toBe(false)
    expect(body.endpoint).toBe('http://opensandbox:99999')
    expect(createSandbox).toHaveBeenCalledTimes(1)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        activeContainerId: 'sbx-fresh',
        containerStatus: 'running',
      })
    )
  })

  it('returns 502 and marks destroyed when createSandbox fails during recreate', async () => {
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
      activeContainerId: null,
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    createSandbox.mockRejectedValueOnce(new Error('boom'))
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(502)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })

  it('returns 504 and marks destroyed when waitUntilRunning times out', async () => {
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
      activeContainerId: null,
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    createSandbox.mockResolvedValue({ id: 'sbx-new' })
    waitUntilRunning.mockRejectedValueOnce(new Error('timed out waiting for Running state'))
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(504)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })

  it('rehydrates an opencode session with coder2 image and port 4096', async () => {
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
      coderType: 'opencode' as const,
      activeContainerId: null,
      workspaceDir: 'D:/tmp/test-sessions/s1/workspace',
      claudeStateDir: 'D:/tmp/test-sessions/s1/claude',
    })
    createSandbox.mockResolvedValue({ id: 'sbx-oc' })
    waitUntilRunning.mockResolvedValue(undefined)
    getEndpoint.mockResolvedValue('http://opensandbox:4096')
    const { POST } = await import('./route')
    const res = await POST(rehydrateReq(), { params: Promise.resolve({ sessionId: 's1' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; alive: boolean }
    expect(body.alive).toBe(false)
    expect(body.endpoint).toBe('http://opensandbox:4096')
    const call = createSandbox.mock.calls[0][0] as { image: string }
    expect(call.image).toBe('proinsight/crewmeld-coder2:latest')
    expect(getEndpoint).toHaveBeenCalledWith(expect.any(String), 4096)
  })
})
