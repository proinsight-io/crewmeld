/**
 * @vitest-environment node
 */
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `paths` reads CREWMELD_BFF_VOLUME_ROOT / CREWMELD_SANDBOX_VOLUME_ROOT
// directly from process.env, so the test mocks it via env vars rather than
// via the dev-studio env shim.
process.env.CREWMELD_BFF_VOLUME_ROOT = 'D:/tmp/test-volume'
process.env.CREWMELD_SANDBOX_VOLUME_ROOT = '/data/test-volume'

vi.mock('../../../../../lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'crewmeld/dev-sandbox:latest',
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
  }),
}))

const mkdirMock = vi.fn().mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  mkdir: (path: string, opts: { recursive: boolean }) => mkdirMock(path, opts),
}))

const createSandbox = vi.fn().mockResolvedValue({ id: 'sbx-1' })
const waitUntilRunning = vi.fn().mockResolvedValue(undefined)
const getEndpoint = vi.fn().mockResolvedValue('http://opensandbox:34567')
const destroy = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../../../lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    createSandbox = createSandbox
    waitUntilRunning = waitUntilRunning
    getEndpoint = getEndpoint
    destroy = destroy
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeList = vi.fn()
const storeCreate = vi.fn()
const storeUpdate = vi.fn()
vi.mock('../../../../../lib/dev-studio/session-store', () => ({
  sessionStore: {
    list: (...args: unknown[]) => storeList(...args),
    create: (...args: unknown[]) => storeCreate(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))


describe('GET /api/employee/dev-studio/sessions', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeList.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions'))
    expect(res.status).toBe(401)
  })

  it('returns sessions for the current user with default status=active', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    const rows = [{ id: 'a', userId: 'user-1', status: 'active' }]
    storeList.mockResolvedValue(rows)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: unknown[] }
    expect(body.sessions).toEqual(rows)
    expect(storeList).toHaveBeenCalledWith('user-1', { q: undefined, status: 'active' })
  })

  it('forwards q and status query params to the store', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'admin',
      error: null,
    })
    storeList.mockResolvedValue([])
    const { GET } = await import('./route')
    await GET(new Request('http://test/api/employee/dev-studio/sessions?q=hello&status=archived'))
    expect(storeList).toHaveBeenCalledWith('user-1', { q: 'hello', status: 'archived' })
  })

  it('falls back to status=active when an unknown status is supplied', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([])
    const { GET } = await import('./route')
    await GET(new Request('http://test/api/employee/dev-studio/sessions?status=bogus'))
    expect(storeList).toHaveBeenCalledWith('user-1', { q: undefined, status: 'active' })
  })
})

describe('POST /api/employee/dev-studio/sessions', () => {
  beforeEach(() => {
    createSandbox.mockClear()
    waitUntilRunning.mockClear()
    getEndpoint.mockClear()
    mkdirMock.mockClear()
    destroy.mockClear()
    storeCreate.mockReset()
    storeUpdate.mockReset()
    storeList.mockReset()
    mockGetCurrentUserRole.mockReset()
    createSandbox.mockResolvedValue({ id: 'sbx-1' })
    waitUntilRunning.mockResolvedValue(undefined)
    getEndpoint.mockResolvedValue('http://opensandbox:34567')
    mkdirMock.mockResolvedValue(undefined)
    destroy.mockResolvedValue(undefined)
    // Pre-flight reuse: POST calls sessionStore.list to detect an existing
    // running container. Default to "no existing sessions" so the happy path
    // proceeds.
    storeList.mockResolvedValue([])
    storeCreate.mockImplementation(async (input: { id?: string }) => ({
      ...input,
      id: input.id ?? 'preset-id',
    }))
    storeUpdate.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    }))
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(401)
    expect(createSandbox).not.toHaveBeenCalled()
    expect(storeCreate).not.toHaveBeenCalled()
  })

  it('creates sandbox with workspace + claude bind mounts and persists DB row', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; endpoint: string }
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.endpoint).toBe('http://opensandbox:34567')

    // Both host subdirectories created BEFORE the sandbox spawn. Paths are
    // derived via paths.sessionWorkspace.forBff() which uses platform-native
    // joining (path.join), so the test mirrors the same construction.
    const expectedWorkspaceBff = path.join(
      'D:/tmp/test-volume',
      'sessions',
      body.sessionId,
      'workspace'
    )
    const expectedClaudeBff = path.join(
      'D:/tmp/test-volume',
      'sessions',
      body.sessionId,
      'claude'
    )
    expect(mkdirMock).toHaveBeenCalledWith(expectedWorkspaceBff, { recursive: true })
    expect(mkdirMock).toHaveBeenCalledWith(expectedClaudeBff, { recursive: true })

    // sessionStore.create is called BEFORE createSandbox so we have a row to
    // patch when the container goes hot/cold. The pre-allocated UUID is passed
    // as `id` so paths, mount labels and the DB row share one identifier.
    expect(storeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.sessionId,
        userId: 'user-1',
        workspaceDir: expectedWorkspaceBff,
        claudeStateDir: expectedClaudeBff,
        containerStatus: 'creating',
        // No modelConfigId in the body → null persisted + global-env fallback
        // label resolved by model-resolver (Sub-spec C).
        modelConfigId: null,
        modelName: '系统默认',
      })
    )

    // Sandbox volumes use the forSandbox() (Linux-style) paths so OpenSandbox
    // running on Ubuntu sees the same physical NFS data as the BFF.
    const expectedWorkspaceSandbox = `/data/test-volume/sessions/${body.sessionId}/workspace`
    const expectedClaudeSandbox = `/data/test-volume/sessions/${body.sessionId}/claude`
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'crewmeld/dev-sandbox:latest',
        entrypoint: ['claude-code-webui', '--host', '0.0.0.0', '--port', '8080'],
        resourceLimits: { cpu: '1000m', memory: '2Gi' },
        timeoutSeconds: 7200,
        volumes: expect.arrayContaining([
          expect.objectContaining({
            hostPath: expectedWorkspaceSandbox,
            mountPath: '/root/workspace',
            readOnly: false,
          }),
          expect.objectContaining({
            hostPath: expectedClaudeSandbox,
            mountPath: '/root/.claude/projects',
            readOnly: false,
          }),
        ]),
      })
    )
    // Exactly 2 mounts — workspace + claude/projects subtree. The rest of
    // `/root/.claude` stays inside the image so plugins + settings.json
    // survive the bind mount.
    const call = createSandbox.mock.calls[0][0] as { volumes: unknown[] }
    expect(call.volumes).toHaveLength(2)

    expect(waitUntilRunning).toHaveBeenCalledWith(
      'sbx-1',
      expect.objectContaining({ timeoutMs: 30_000 })
    )
    expect(getEndpoint).toHaveBeenCalledWith('sbx-1', 8080)

    // After endpoint resolves, the DB row is updated with the live container info.
    expect(storeUpdate).toHaveBeenCalledWith(
      body.sessionId,
      expect.objectContaining({
        activeContainerId: 'sbx-1',
        containerStatus: 'running',
      })
    )

  })

  it('returns 500 if workspace mkdir fails', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('EACCES'))
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('workspace-mkdir-failed')
    // Neither the sandbox nor the DB row should have been created.
    expect(createSandbox).not.toHaveBeenCalled()
    expect(storeCreate).not.toHaveBeenCalled()
  })

  it('returns 502 if createSandbox throws and marks the DB row destroyed', async () => {
    createSandbox.mockRejectedValueOnce(new Error('boom'))
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; retryable: boolean }
    expect(body.error).toBe('sandbox-unreachable')
    expect(body.retryable).toBe(true)

    // Row is preserved with containerStatus=destroyed so the UI can still show
    // the session in the list.
    const createdId = (storeCreate.mock.calls[0][0] as { id: string }).id
    expect(storeUpdate).toHaveBeenCalledWith(
      createdId,
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })

  it('wraps entrypoint in /bin/sh -c to write pip.conf when CREWMELD_PIP_INDEX_URL is set', async () => {
    const envMod = await import('../../../../../lib/dev-studio/env')
    vi.spyOn(envMod, 'getDevStudioEnv').mockReturnValueOnce({
      OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
      OPENSANDBOX_API_KEY: 'k',
      CREWMELD_SANDBOX_IMAGE: 'crewmeld/dev-sandbox:latest',
      CREWMELD_SANDBOX_TTL_SECONDS: 7200,
      CREWMELD_SESSIONS_DIR: 'D:/tmp/test-sessions',
      CREWMELD_BFF_VOLUME_ROOT: 'D:/tmp/test-volume',
      CREWMELD_SANDBOX_VOLUME_ROOT: '/data/test-volume',
      CREWMELD_SANDBOX_CPU: '1000m',
      CREWMELD_SANDBOX_MEMORY: '2Gi',
      CREWMELD_PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'http://anthropic',
      ANTHROPIC_MODEL: 'qianfan-code-latest',
    } as ReturnType<typeof envMod.getDevStudioEnv>)

    const { POST } = await import('./route')
    await POST(new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' }))

    const call = createSandbox.mock.calls[0][0] as { entrypoint: string[] }
    expect(call.entrypoint[0]).toBe('/bin/sh')
    expect(call.entrypoint[1]).toBe('-c')
    const script = call.entrypoint[2]
    expect(script).toContain('/root/.pip/pip.conf')
    expect(script).toContain('https://pypi.tuna.tsinghua.edu.cn/simple')
    expect(script).toContain('pypi.tuna.tsinghua.edu.cn')
    expect(script).toContain('exec claude-code-webui --host 0.0.0.0 --port 8080')
  })

  it('suspends an existing running container, then creates a new session', async () => {
    // Pre-flight: when the user already has a running container, POST tears it
    // down (destroy + demote the old row to 'destroyed') and proceeds to create
    // a fresh session. This backs the explicit "new session" entry — the single
    // running container per user is enforced by destroying the old one server-
    // side, not by rejecting the request. (Was previously a 409 'already-running'
    // contract; the route now suspends-and-creates.)
    storeList.mockResolvedValueOnce([
      {
        id: 'existing-session',
        userId: 'user-1',
        status: 'active',
        containerStatus: 'running',
        activeContainerId: 'sbx-old',
      },
    ])
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; endpoint: string }
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.sessionId).not.toBe('existing-session')

    // Old container torn down and its row demoted before the new one starts.
    expect(destroy).toHaveBeenCalledWith('sbx-old')
    expect(storeUpdate).toHaveBeenCalledWith(
      'existing-session',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )

    // New session genuinely created.
    expect(storeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', containerStatus: 'creating' })
    )
    expect(createSandbox).toHaveBeenCalled()
  })

  it('proceeds when existing active sessions exist but none are running', async () => {
    // 'destroyed' rows must not block a new POST — they're just history.
    storeList.mockResolvedValueOnce([
      {
        id: 'old-session',
        userId: 'user-1',
        status: 'active',
        containerStatus: 'destroyed',
      },
    ])
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(200)
    expect(createSandbox).toHaveBeenCalled()
  })

  it('opencode default: creates coder2 sandbox with opencode-data mount', async () => {
    const envMod = await import('../../../../../lib/dev-studio/env')
    vi.spyOn(envMod, 'getDevStudioEnv').mockReturnValueOnce({
      OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
      OPENSANDBOX_API_KEY: 'k',
      CREWMELD_SANDBOX_IMAGE: 'crewmeld/dev-sandbox:latest',
      CREWMELD_OPENCODE_IMAGE: 'proinsight/crewmeld-coder2:latest',
      CREWMELD_CODER_DEFAULT: 'opencode',
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
      OPENCODE_PORT: 4096,
      OPENCODE_SERVER_PASSWORD: undefined,
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENSANDBOX_USE_PROXY: false,
      ANTHROPIC_SMALL_FAST_MODEL: undefined,
    } as ReturnType<typeof envMod.getDevStudioEnv>)

    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(200)

    // createSandbox must use the opencode image
    const call = createSandbox.mock.calls[0][0] as {
      image: string
      volumes: Array<{ mountPath: string }>
    }
    expect(call.image).toBe('proinsight/crewmeld-coder2:latest')

    // Mount paths: workspace + opencode data dir (not claude/projects)
    expect(call.volumes.map((v) => v.mountPath)).toEqual([
      '/root/workspace',
      '/root/.local/share/opencode',
    ])

    // coderType must be persisted
    expect(storeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ coderType: 'opencode' }),
    )
  })

  it('cleans up orphan sandbox when final UPDATE→running loses the race', async () => {
    // Simulate the partial unique index firing on the promotion UPDATE
    // (the pre-flight passed because a concurrent request had not yet
    // committed). The handler must destroy the orphan container and patch
    // the row back to destroyed, then return 409.
    storeUpdate.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "tool_dev_sessions_user_running_uidx"'
      )
    )
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('race-condition')
    // Orphan sandbox was torn down.
    expect(destroy).toHaveBeenCalledWith('sbx-1')
    // Row was patched back to destroyed (second storeUpdate call, since the
    // first one rejected).
    expect(storeUpdate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })

  it('returns 504 if waitUntilRunning throws timeout and marks row destroyed', async () => {
    waitUntilRunning.mockRejectedValueOnce(new Error('timed out waiting for Running state'))
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://test/api/employee/dev-studio/sessions', { method: 'POST' })
    )
    expect(res.status).toBe(504)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('sandbox-timeout')
    const createdId = (storeCreate.mock.calls[0][0] as { id: string }).id
    expect(storeUpdate).toHaveBeenCalledWith(
      createdId,
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })
})
