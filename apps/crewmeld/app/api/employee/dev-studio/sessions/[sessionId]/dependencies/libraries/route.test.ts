/**
 * @vitest-environment node
 *
 * Tests for PUT /api/employee/dev-studio/sessions/:sessionId/dependencies/libraries —
 * the test-panel dependency-editor save. Writes the full library list into the
 * session manifest (mirrored to requirements.txt by setManifestLibraries).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: { get: (...args: unknown[]) => storeGet(...args) },
}))

const setManifestLibraries = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  setManifestLibraries: (...args: unknown[]) => setManifestLibraries(...args),
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
  return new Request('http://test/api/employee/dev-studio/sessions/s1/dependencies/libraries', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('PUT /sessions/:sessionId/dependencies/libraries', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    setManifestLibraries.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      error: 'api.common.unauthorized',
    })
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ libraries: [] }), ctx)).status).toBe(401)
    expect(setManifestLibraries).not.toHaveBeenCalled()
  })

  it('returns 404 cross-user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ libraries: [] }), ctx)).status).toBe(404)
  })

  it('returns 400 on bad body shape', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ libraries: 'nope' }), ctx)).status).toBe(400)
    expect(setManifestLibraries).not.toHaveBeenCalled()
  })

  it('persists the library list and echoes it', async () => {
    authedOwner()
    setManifestLibraries.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.7', 'requests'], domains: [], ips: [] },
    })
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ libraries: ['markdown>=3.7', 'requests'] }), ctx)
    expect(res.status).toBe(200)
    expect(setManifestLibraries).toHaveBeenCalledWith('s1', ['markdown>=3.7', 'requests'])
    const body = (await res.json()) as { libraries: string[] }
    expect(body.libraries).toEqual(['markdown>=3.7', 'requests'])
  })

  it('returns 409 when the manifest does not exist yet', async () => {
    authedOwner()
    setManifestLibraries.mockRejectedValue(
      new Error('CONFLICT: manifest does not exist; AI must create it first')
    )
    const { PUT } = await import('./route')
    expect((await PUT(putReq({ libraries: ['x'] }), ctx)).status).toBe(409)
  })
})
