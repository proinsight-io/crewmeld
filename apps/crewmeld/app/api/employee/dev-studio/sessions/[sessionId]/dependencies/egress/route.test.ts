/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: { get: (...a: unknown[]) => storeGet(...a) },
}))

const setSessionManifestEgress = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  setSessionManifestEgress: (...a: unknown[]) => setSessionManifestEgress(...a),
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

function putReq(body: unknown): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/dependencies/egress', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('PUT /sessions/:sessionId/dependencies/egress', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    setSessionManifestEgress.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: false, userId: null, error: 'x' })
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: [], ips: [] }), ctx)).status).toBe(401)
    expect(setSessionManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 404 cross-user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true, userId: 'user-1', role: 'member', error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: [], ips: [] }), ctx)).status).toBe(404)
    expect(setSessionManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 400 on bad body shape', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: 'nope' }), ctx)).status).toBe(400)
    expect(setSessionManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid domain (not FQDN)', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: ['10.0.0.5'], ips: [] }), ctx)).status).toBe(400)
    expect(setSessionManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid ip', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: [], ips: ['999.1.1.1'] }), ctx)).status).toBe(400)
    expect(setSessionManifestEgress).not.toHaveBeenCalled()
  })

  it('persists valid egress and echoes it', async () => {
    authedOwner()
    setSessionManifestEgress.mockResolvedValue({
      dependencies: { libraries: ['requests'], domains: ['wttr.in'], ips: ['10.0.0.5'] },
    })
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: ['wttr.in'], ips: ['10.0.0.5'] }), ctx)
    expect(res.status).toBe(200)
    expect(setSessionManifestEgress).toHaveBeenCalledWith('s1', {
      domains: ['wttr.in'],
      ips: ['10.0.0.5'],
    })
    const body = (await res.json()) as { domains: string[]; ips: string[] }
    expect(body).toEqual({ domains: ['wttr.in'], ips: ['10.0.0.5'] })
  })

  it('returns 409 when the manifest does not exist yet', async () => {
    authedOwner()
    setSessionManifestEgress.mockRejectedValue(
      new Error('CONFLICT: manifest does not exist; AI must create it first')
    )
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ domains: ['wttr.in'], ips: [] }), ctx)).status).toBe(409)
  })
})
