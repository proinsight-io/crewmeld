/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/notifications.
 *
 * Aggregates two kinds of pending HITL items across all active sessions
 * owned by the caller:
 *
 *  - dependency approvals: manifest.dependencies.{libraries,domains} minus
 *    session.approvedDependencies.{libraries,domains}
 *  - asks: rows in tool_dev_pending_actions where status='pending', joined
 *    back to session.title for display.
 *
 * Cross-user data must NOT leak — `sessionStore.list(userId)` only returns
 * the caller's sessions, and the asks query is restricted to those session
 * ids via inArray.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeList = vi.fn()
const storeHasActiveStreaming = vi.fn().mockReturnValue(false)
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    list: (...args: unknown[]) => storeList(...args),
    hasActiveStreaming: (...args: unknown[]) => storeHasActiveStreaming(...args),
  },
}))

const readManifestFromSession = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  readManifestFromSession: (...args: unknown[]) => readManifestFromSession(...args),
}))

const getSandboxSettings = vi.fn()
vi.mock('@/lib/sandbox/settings', () => ({
  getSandboxSettings: () => getSandboxSettings(),
}))

/**
 * db.select().from(table).where(...) resolves to whatever `selectRows`
 * holds at the time the await fires.
 */
let selectRows: unknown[] = []
vi.mock('@crewmeld/db', () => {
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => Promise.resolve(selectRows)),
    }
    return builder
  })
  return {
    db: { select },
    toolDevPendingActions: {
      __table: 'tool_dev_pending_actions',
      sessionId: 'session_id',
      askId: 'ask_id',
      type: 'type',
      payload: 'payload',
      status: 'status',
    },
  }
})

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: 'user-1',
    title: 'demo',
    workspaceDir: '/ws/s1',
    approvedDependencies: { libraries: [], domains: [] },
    ...overrides,
  }
}

describe('GET /api/employee/dev-studio/notifications', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeList.mockReset()
    readManifestFromSession.mockReset()
    storeHasActiveStreaming.mockReset().mockReturnValue(false)
    getSandboxSettings.mockReset().mockResolvedValue({
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
      egressMode: 'unrestricted',
    })
    selectRows = []
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(401)
    expect(storeList).not.toHaveBeenCalled()
  })

  it('returns empty arrays when user has no active sessions', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([])
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      dependencies: unknown[]
      asks: unknown[]
    }
    expect(body.dependencies).toEqual([])
    expect(body.asks).toEqual([])
  })

  it('returns empty dependencies when manifest is missing for a session', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([makeSession()])
    readManifestFromSession.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dependencies: unknown[]; asks: unknown[] }
    expect(body.dependencies).toEqual([])
  })

  it('returns empty dependencies when nothing is pending (all approved)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([
      makeSession({
        approvedDependencies: { libraries: ['lxml'], domains: ['example.com'] },
      }),
    ])
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['lxml'], domains: ['example.com'] },
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dependencies: unknown[] }
    expect(body.dependencies).toEqual([])
  })

  it('reports pending ips for a session', async () => {
  // manifest.ips=['10.0.0.5'], approvedDependencies.ips=[]
  const { GET } = await import('./route')
  const req = new Request('http://test/api/employee/dev-studio/notifications')
  const body = await (await GET(req)).json()
  expect(body.dependencies[0].pendingIps).toContain('10.0.0.5')
  })

  it('excludes libraries covered by the global preset packages (by normalized name)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([makeSession()])
    // markdown is globally preset → not pending; requests is not → pending.
    getSandboxSettings.mockResolvedValue({
      presetPythonPackages: ['markdown'],
      allowedIps: [],
      allowedDomains: [],
      egressMode: 'unrestricted',
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5', 'requests'], domains: [] },
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    const body = (await res.json()) as {
      dependencies: Array<{ pendingLibraries: string[] }>
    }
    expect(body.dependencies).toHaveLength(1)
    expect(body.dependencies[0].pendingLibraries).toEqual(['requests'])
  })

  it('emits no dependency entry when every library is globally preset', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([makeSession()])
    getSandboxSettings.mockResolvedValue({
      presetPythonPackages: ['markdown', 'requests'],
      allowedIps: [],
      allowedDomains: [],
      egressMode: 'unrestricted',
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5', 'requests'], domains: [] },
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    const body = (await res.json()) as { dependencies: unknown[] }
    expect(body.dependencies).toEqual([])
  })

  it('aggregates pending dependencies (libraries + domains) across sessions', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([
      makeSession({
        id: 'sA',
        title: 'tool A',
        workspaceDir: '/ws/A',
        approvedDependencies: { libraries: ['lxml'], domains: [] },
      }),
      makeSession({
        id: 'sB',
        title: 'tool B',
        workspaceDir: '/ws/B',
        approvedDependencies: { libraries: [], domains: ['foo.com'] },
      }),
    ])
    readManifestFromSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'sA') {
        return Promise.resolve({
          dependencies: { libraries: ['lxml', 'numpy'], domains: ['evil.com'] },
        })
      }
      return Promise.resolve({
        dependencies: { libraries: ['scipy'], domains: ['foo.com', 'bar.com'] },
      })
    })
    storeHasActiveStreaming.mockImplementation((id: string) => id === 'sA')
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      dependencies: Array<{
        sessionId: string
        sessionTitle: string
        pendingLibraries: string[]
        pendingDomains: string[]
        streaming: boolean
      }>
    }
    expect(body.dependencies).toHaveLength(2)
    const a = body.dependencies.find((d) => d.sessionId === 'sA')
    expect(a?.sessionTitle).toBe('tool A')
    expect(a?.pendingLibraries).toEqual(['numpy'])
    expect(a?.pendingDomains).toEqual(['evil.com'])
    expect(a?.streaming).toBe(true)
    const b = body.dependencies.find((d) => d.sessionId === 'sB')
    expect(b?.pendingLibraries).toEqual(['scipy'])
    expect(b?.pendingDomains).toEqual(['bar.com'])
    expect(b?.streaming).toBe(false)
  })

  it('fills in a placeholder title when session.title is null', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([makeSession({ title: null })])
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['x'], domains: [] },
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    const body = (await res.json()) as {
      dependencies: Array<{ sessionTitle: string }>
    }
    expect(body.dependencies[0].sessionTitle).toBe('构思中…')
  })

  it('returns asks joined to session titles, with streaming flag', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([
      makeSession({ id: 'sA', title: 'A title' }),
      makeSession({ id: 'sB', title: null }),
    ])
    readManifestFromSession.mockResolvedValue(null)
    selectRows = [
      {
        sessionId: 'sA',
        askId: 'q1',
        type: 'choice',
        payload: { question: 'pick' },
      },
      {
        sessionId: 'sB',
        askId: 'q2',
        type: 'text',
        payload: { prompt: 'free form' },
      },
    ]
    storeHasActiveStreaming.mockImplementation((id: string) => id === 'sB')
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      asks: Array<{
        sessionId: string
        sessionTitle: string
        askId: string
        type: string
        payload: unknown
        streaming: boolean
      }>
    }
    expect(body.asks).toHaveLength(2)
    const askA = body.asks.find((a) => a.askId === 'q1')
    expect(askA?.sessionTitle).toBe('A title')
    expect(askA?.type).toBe('choice')
    expect(askA?.streaming).toBe(false)
    const askB = body.asks.find((a) => a.askId === 'q2')
    expect(askB?.sessionTitle).toBe('构思中…')
    expect(askB?.streaming).toBe(true)
  })

  it('skips the asks query entirely when there are zero active sessions', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([])
    // If the route accidentally queried the table, selectRows would be returned
    // for a row the caller doesn't own — assert against that leak path.
    selectRows = [
      {
        sessionId: 'leaked-session',
        askId: 'q-leak',
        type: 'choice',
        payload: {},
      },
    ]
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { asks: unknown[] }
    expect(body.asks).toEqual([])
  })

  it('only lists active sessions (call carries status=active)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeList.mockResolvedValue([])
    const { GET } = await import('./route')
    await GET(new Request('http://test/api/employee/dev-studio/notifications'))
    expect(storeList).toHaveBeenCalledWith('user-1', { status: 'active' })
  })
})
