/**
 * @vitest-environment node
 *
 * Tests for POST /api/employee/dev-studio/sessions/:sessionId/dependencies/approve.
 *
 * Approval is a pure acknowledgement: it snapshots the current manifest deps
 * into approvedDependencies so the review signal clears. It does NOT rewrite
 * the manifest.
 *
 * Since Task 8 C1 fix, the route also accepts an optional body with
 * `rejectedDomains` / `rejectedIps` and accumulates them into the session's
 * existing rejected sets (so multiple review rounds are cumulative).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))

const readManifestFromSession = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  readManifestFromSession: (...args: unknown[]) => readManifestFromSession(...args),
}))

function authedOwner(approvedDependencies?: {
  libraries?: string[]
  domains?: string[]
  ips?: string[]
  rejectedDomains?: string[]
  rejectedIps?: string[]
}) {
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
    approvedDependencies: approvedDependencies ?? { libraries: [], domains: [], ips: [] },
  })
}

function approveReq(body: unknown = {}): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/dependencies/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('POST /sessions/:sessionId/dependencies/approve', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
    readManifestFromSession.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    expect((await POST(approveReq(), ctx)).status).toBe(401)
    expect(storeUpdate).not.toHaveBeenCalled()
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
    expect((await POST(approveReq(), ctx)).status).toBe(404)
  })

  it('returns 409 when the manifest does not exist yet', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue(null)
    const { POST } = await import('./route')
    expect((await POST(approveReq(), ctx)).status).toBe(409)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  it('snapshots the current manifest deps into approvedDependencies', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5', 'requests'], domains: ['api.example.com'], ips: [] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq(), ctx)
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', {
      approvedDependencies: expect.objectContaining({
        libraries: ['markdown>=3.5', 'requests'],
        domains: ['api.example.com'],
      }),
    })
    const body = (await res.json()) as { approved: { libraries: string[]; domains: string[] } }
    expect(body.approved.libraries).toEqual(['markdown>=3.5', 'requests'])
  })

  it('snapshots manifest ips into approvedDependencies', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: ['10.0.0.5'] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq(), ctx)
    expect(storeUpdate).toHaveBeenCalledWith('s1', {
      approvedDependencies: expect.objectContaining({ ips: ['10.0.0.5'] }),
    })
  })

  it('persists rejectedDomains and rejectedIps from POST body', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq({ rejectedDomains: ['evil.com'], rejectedIps: ['1.2.3.4'] }), ctx)
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', {
      approvedDependencies: expect.objectContaining({
        rejectedDomains: expect.arrayContaining(['evil.com']),
        rejectedIps: expect.arrayContaining(['1.2.3.4']),
      }),
    })
  })

  it('accumulates rejected sets across multiple review rounds (merge, no overwrite)', async () => {
    authedOwner({
      libraries: [],
      domains: [],
      ips: [],
      rejectedDomains: ['old.com'],
      rejectedIps: ['9.9.9.9'],
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq({ rejectedDomains: ['new.com'], rejectedIps: ['1.1.1.1'] }), ctx)
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', {
      approvedDependencies: expect.objectContaining({
        rejectedDomains: expect.arrayContaining(['old.com', 'new.com']),
        rejectedIps: expect.arrayContaining(['9.9.9.9', '1.1.1.1']),
      }),
    })
  })

  it('deduplicates rejected entries when same item is submitted twice', async () => {
    authedOwner({
      libraries: [],
      domains: [],
      ips: [],
      rejectedDomains: ['dup.com'],
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    await POST(approveReq({ rejectedDomains: ['dup.com', 'other.com'] }), ctx)
    const updateArg = storeUpdate.mock.calls[0][1] as {
      approvedDependencies: { rejectedDomains: string[] }
    }
    const rejected = updateArg.approvedDependencies.rejectedDomains
    const dupCount = rejected.filter((d) => d === 'dup.com').length
    expect(dupCount).toBe(1)
  })

  it('returns 200 with empty body {} (backward-compatible with existing frontend)', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq({}), ctx)
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', {
      approvedDependencies: expect.objectContaining({
        rejectedDomains: [],
        rejectedIps: [],
      }),
    })
  })

  it('drops re-approved hosts from the rejected set', async () => {
    // Session already has rejectedDomains = ['foo.com'] from a previous round.
    // This round the operator re-checked 'foo.com' in the dependency editor and
    // the manifest now lists it under dependencies.domains (PUT egress already
    // wrote it). On POST /approve the route must subtract the approved set from
    // the rejected set so 'foo.com' no longer appears as rejected.
    authedOwner({
      libraries: [],
      domains: [],
      ips: [],
      rejectedDomains: ['foo.com', 'still-bad.com'],
      rejectedIps: ['10.0.0.1'],
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: {
        libraries: [],
        domains: ['foo.com'], // re-approved by the operator
        ips: ['10.0.0.1'],   // also re-approved
      },
    })
    storeUpdate.mockResolvedValue({})
    const { POST } = await import('./route')
    const res = await POST(approveReq({}), ctx)
    expect(res.status).toBe(200)
    const updateArg = storeUpdate.mock.calls[0][1] as {
      approvedDependencies: { rejectedDomains: string[]; rejectedIps: string[] }
    }
    const { rejectedDomains, rejectedIps } = updateArg.approvedDependencies
    // 'foo.com' was re-approved — must be gone from the rejected set
    expect(rejectedDomains).not.toContain('foo.com')
    // 'still-bad.com' was never re-approved — must stay
    expect(rejectedDomains).toContain('still-bad.com')
    // '10.0.0.1' was re-approved — must be gone
    expect(rejectedIps).not.toContain('10.0.0.1')
  })

  it('returns 400 when body contains unexpected fields (strict schema)', async () => {
    authedOwner()
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
    })
    const { POST } = await import('./route')
    const res = await POST(approveReq({ unknownField: 'oops' }), ctx)
    expect(res.status).toBe(400)
  })
})
