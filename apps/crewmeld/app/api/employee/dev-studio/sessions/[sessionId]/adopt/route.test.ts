/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adoptSession: vi.fn(),
  destroy: vi.fn(),
  destroyPreview: vi.fn(),
  getCurrentUserRole: vi.fn(),
  sessionGet: vi.fn(),
}))

vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mocks.getCurrentUserRole(),
}))

vi.mock('@/lib/dev-studio/adopt-handler', () => ({
  adoptSession: (...args: unknown[]) => mocks.adoptSession(...args),
}))

vi.mock('@/lib/dev-studio/dependency-prewarmer', () => ({
  AdoptError: class AdoptError extends Error {
    constructor(
      public code: string,
      public detail: string,
      public retryable: boolean
    ) {
      super(detail)
    }
  },
}))

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'key',
    OPENSANDBOX_USE_PROXY: false,
  }),
}))

vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    destroy = mocks.destroy
  },
}))

vi.mock('@/lib/dev-studio/service-preview-lifecycle', () => ({
  destroySessionServicePreview: (...args: unknown[]) => mocks.destroyPreview(...args),
}))

vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: { get: (...args: unknown[]) => mocks.sessionGet(...args) },
}))

const url = 'http://test/api/employee/dev-studio/sessions/session-1/adopt'
const ctx = { params: Promise.resolve({ sessionId: 'session-1' }) }
const result = {
  toolId: 'tool-1',
  toolName: 'Weather Query',
  isUpdate: false,
  needsRedeploy: false,
}

async function readEvents(response: Response): Promise<unknown[]> {
  const body = await response.text()
  return body
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as unknown)
}

describe('PATCH /api/employee/dev-studio/sessions/:sessionId/adopt', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.adoptSession.mockReset()
    mocks.destroy.mockReset()
    mocks.destroyPreview.mockReset()
    mocks.getCurrentUserRole.mockReset()
    mocks.sessionGet.mockReset()

    mocks.getCurrentUserRole.mockResolvedValue({ authenticated: true, userId: 'user-1' })
    mocks.sessionGet.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'active',
      activeContainerId: 'sandbox-1',
    })
    mocks.adoptSession.mockResolvedValue(result)
    mocks.destroy.mockResolvedValue(undefined)
    mocks.destroyPreview.mockResolvedValue(undefined)
  })

  it('returns 401 when unauthenticated', async () => {
    mocks.getCurrentUserRole.mockResolvedValue({ authenticated: false, userId: null })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request(url, { method: 'PATCH' }), ctx)
    expect(response.status).toBe(401)
    expect(mocks.adoptSession).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing or foreign session', async () => {
    mocks.sessionGet.mockResolvedValue(null)
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request(url, { method: 'PATCH' }), ctx)
    expect(response.status).toBe(404)
    expect(mocks.adoptSession).not.toHaveBeenCalled()
  })

  it('returns 409 for an already adopted session', async () => {
    mocks.sessionGet.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'adopted',
      activeContainerId: null,
    })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request(url, { method: 'PATCH' }), ctx)
    expect(response.status).toBe(409)
  })

  it('preserves the JSON response for callers that do not request SSE', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request(url, { method: 'PATCH' }), ctx)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual(result)
    expect(mocks.destroyPreview).toHaveBeenCalledWith('session-1')
    expect(mocks.destroy).toHaveBeenCalledWith('sandbox-1')
  })

  it('streams reported phases, closing, and completion for SSE callers', async () => {
    mocks.adoptSession.mockImplementation(async (_sessionId, _userId, report) => {
      await report({ type: 'progress', step: 'syncing' })
      await report({
        type: 'progress',
        step: 'installing-dependencies',
        libraries: ['requests', 'pymysql'],
      })
      await report({ type: 'progress', step: 'saving' })
      return result
    })
    const { PATCH } = await import('./route')
    const response = await PATCH(
      new Request(url, { method: 'PATCH', headers: { Accept: 'text/event-stream' } }),
      ctx
    )
    const events = await readEvents(response)

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(events).toEqual([
      { type: 'progress', step: 'syncing' },
      {
        type: 'progress',
        step: 'installing-dependencies',
        libraries: ['requests', 'pymysql'],
      },
      { type: 'progress', step: 'saving' },
      { type: 'progress', step: 'closing' },
      { type: 'complete', ...result },
    ])
    expect(mocks.destroyPreview).toHaveBeenCalledWith('session-1')
  })

  it('streams retryable AdoptError details instead of throwing after startup', async () => {
    const { AdoptError } = await import('@/lib/dev-studio/dependency-prewarmer')
    mocks.adoptSession.mockRejectedValue(
      new AdoptError('dependency-install-failed', 'pip failed', true)
    )
    const { PATCH } = await import('./route')
    const response = await PATCH(
      new Request(url, { method: 'PATCH', headers: { Accept: 'text/event-stream' } }),
      ctx
    )

    await expect(readEvents(response)).resolves.toEqual([
      { type: 'error', message: 'pip failed', retryable: true },
    ])
  })
})
