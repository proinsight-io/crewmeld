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
    CREWMELD_BFF_VOLUME_ROOT: 'D:/tmp/test-volume',
    CREWMELD_SANDBOX_VOLUME_ROOT: '/data/test-volume',
    CREWMELD_SANDBOX_CPU: '1000m',
    CREWMELD_SANDBOX_MEMORY: '2Gi',
    CREWMELD_PIP_INDEX_URL: undefined,
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_PORT: 4096,
  }),
}))

const createSandbox = vi.fn()
const waitUntilRunning = vi.fn()
const getEndpoint = vi.fn()
const destroy = vi.fn()
const proxyHeaders = vi.fn()
vi.mock('../../../../../../../lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    createSandbox = createSandbox
    waitUntilRunning = waitUntilRunning
    getEndpoint = getEndpoint
    destroy = destroy
    proxyHeaders = proxyHeaders
  },
}))

const listOpencodeMessages = vi.fn()
const abortOpencodeSession = vi.fn()
const promptOpencodeAsync = vi.fn()
vi.mock('@/lib/dev-studio/opencode-rest', () => ({
  CREWMELD_OPENCODE_PROVIDER_ID: 'myprovider',
  listOpencodeMessages: (...args: unknown[]) => listOpencodeMessages(...args),
  findLastVisibleUserText: (messages: Array<{ info: { role: string }; parts: Array<{ text?: string }> }>) =>
    messages
      .slice()
      .reverse()
      .find((message) => message.info.role === 'user')
      ?.parts[0]?.text ?? null,
  abortOpencodeSession: (...args: unknown[]) => abortOpencodeSession(...args),
  promptOpencodeAsync: (...args: unknown[]) => promptOpencodeAsync(...args),
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn()
vi.mock('../../../../../../../lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))

const resolveModelEnv = vi.fn()
vi.mock('../../../../../../../lib/dev-studio/model-resolver', () => ({
  resolveModelEnv: (...args: unknown[]) => resolveModelEnv(...args),
}))

const RESOLVED = {
  modelConfigId: 'mc-effective',
  opencodeBaseURL: 'http://anthropic',
  opencodeApiKey: 'tok',
  opencodeModelID: 'claude-4-sonnet',
  opencodeProtocol: 'openai-compatible' as const,
  ANTHROPIC_AUTH_TOKEN: 'tok',
  ANTHROPIC_BASE_URL: 'http://anthropic',
  ANTHROPIC_MODEL: 'claude-4-sonnet',
  ANTHROPIC_SMALL_FAST_MODEL: 'claude-4-sonnet',
  displayLabel: 'Claude 编程 / claude-4-sonnet',
}

function patchReq(body: unknown): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/model', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ACTIVE_SESSION = {
  id: 's1',
  userId: 'user-1',
  status: 'active',
  activeContainerId: 'sbx-old',
  modelConfigId: null,
  workspaceDir: 'D:/tmp/test-volume/sessions/s1/workspace',
  claudeStateDir: 'D:/tmp/test-volume/sessions/s1/claude',
}

describe('PATCH /api/employee/dev-studio/sessions/:sessionId/model', () => {
  beforeEach(() => {
    createSandbox.mockReset().mockResolvedValue({ id: 'sbx-new' })
    waitUntilRunning.mockReset().mockResolvedValue(undefined)
    getEndpoint.mockReset().mockResolvedValue('http://opensandbox:55555')
    destroy.mockReset().mockResolvedValue(undefined)
    proxyHeaders.mockReset().mockReturnValue({})
    listOpencodeMessages.mockReset().mockResolvedValue([])
    abortOpencodeSession.mockReset().mockResolvedValue(true)
    promptOpencodeAsync.mockReset().mockResolvedValue(undefined)
    storeGet.mockReset()
    storeUpdate.mockReset().mockResolvedValue(undefined)
    mockGetCurrentUserRole.mockReset()
    resolveModelEnv.mockReset().mockResolvedValue(RESOLVED)
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
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('returns 404 when session is missing or not owned', async () => {
    storeGet.mockResolvedValueOnce(null)
    const { PATCH } = await import('./route')
    let res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)

    storeGet.mockResolvedValueOnce({ ...ACTIVE_SESSION, userId: 'other' })
    res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 410 when session is not active', async () => {
    storeGet.mockResolvedValue({ ...ACTIVE_SESSION, status: 'archived' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(410)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('returns 400 when the model config cannot be resolved', async () => {
    storeGet.mockResolvedValue(ACTIVE_SESSION)
    resolveModelEnv.mockRejectedValueOnce(new Error('Model config is disabled: mc-2'))
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('switches model: destroys old container, recreates on same dirs, returns new label', async () => {
    storeGet.mockResolvedValue(ACTIVE_SESSION)
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; modelName: string }
    expect(body.endpoint).toBe('http://opensandbox:55555')
    expect(body.modelName).toBe('Claude 编程 / claude-4-sonnet')

    expect(resolveModelEnv).toHaveBeenCalledWith('mc-2')
    // Old container torn down.
    expect(destroy).toHaveBeenCalledWith('sbx-old')
    // Row pinned to the new model + marked creating before recreate.
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        modelConfigId: 'mc-effective',
        modelName: 'Claude 编程 / claude-4-sonnet',
        containerStatus: 'creating',
        activeContainerId: null,
      })
    )
    // New container bound to the SAME forSandbox() dirs, env from resolved model.
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'claude-4-sonnet' }),
        volumes: expect.arrayContaining([
          expect.objectContaining({ hostPath: '/data/test-volume/sessions/s1/workspace' }),
          expect.objectContaining({ hostPath: '/data/test-volume/sessions/s1/claude' }),
        ]),
      })
    )
    // Promoted to running with the fresh container id.
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ activeContainerId: 'sbx-new', containerStatus: 'running' })
    )
  })

  it('switches to system default when modelConfigId is null', async () => {
    storeGet.mockResolvedValue({ ...ACTIVE_SESSION, modelConfigId: 'mc-old' })
    resolveModelEnv.mockResolvedValue({ ...RESOLVED, modelConfigId: null, displayLabel: '系统默认' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: null }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    expect(resolveModelEnv).toHaveBeenCalledWith(null)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ modelConfigId: null, modelName: '系统默认' })
    )
  })

  it('returns 502 and marks destroyed when createSandbox fails', async () => {
    storeGet.mockResolvedValue(ACTIVE_SESSION)
    createSandbox.mockRejectedValueOnce(new Error('boom'))
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(502)
    expect(storeUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
  })

  it('switches model on an opencode session with coder2 image and port 4096', async () => {
    storeGet.mockResolvedValue({ ...ACTIVE_SESSION, coderType: 'opencode' as const })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const call = createSandbox.mock.calls[0][0] as { image: string }
    expect(call.image).toBe('proinsight/crewmeld-coder2:latest')
    expect(getEndpoint).toHaveBeenCalledWith(expect.any(String), 4096)
  })

  it('aborts, rebuilds, then replays the last OpenCode question with the new model', async () => {
    const order: string[] = []
    storeGet.mockResolvedValue({
      ...ACTIVE_SESSION,
      coderType: 'opencode' as const,
      opencodeSessionId: 'oc-1',
    })
    getEndpoint.mockImplementation(async () => {
      order.push('endpoint')
      return 'http://opensandbox:55555'
    })
    listOpencodeMessages.mockImplementation(async () => {
      order.push('history')
      return [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'build weather tool' }] }]
    })
    abortOpencodeSession.mockImplementation(async () => {
      order.push('abort')
      return true
    })
    destroy.mockImplementation(async () => {
      order.push('destroy')
    })
    createSandbox.mockImplementation(async () => {
      order.push('create')
      return { id: 'sbx-new' }
    })
    promptOpencodeAsync.mockImplementation(async () => {
      order.push('replay')
    })

    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ modelConfigId: 'mc-2' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })

    expect(res.status).toBe(200)
    expect(order).toEqual(['endpoint', 'history', 'abort', 'destroy', 'create', 'endpoint', 'replay'])
    expect(promptOpencodeAsync).toHaveBeenCalledWith(
      'http://opensandbox:55555',
      expect.any(Object),
      'oc-1',
      expect.stringContaining('build weather tool'),
      { providerID: 'myprovider', modelID: 'claude-4-sonnet' }
    )
    expect(await res.json()).toMatchObject({
      modelConfigId: 'mc-effective',
      aborted: true,
      replay: 'started',
    })
  })
})
