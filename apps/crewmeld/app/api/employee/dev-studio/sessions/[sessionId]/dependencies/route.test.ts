/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/sessions/:sessionId/dependencies —
 * the payload backing the inline package allow-list review card.
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

const readManifestFromSession = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  readManifestFromSession: (...args: unknown[]) => readManifestFromSession(...args),
}))

const getSandboxSettings = vi.fn()
vi.mock('@/lib/sandbox/settings', () => ({
  getSandboxSettings: () => getSandboxSettings(),
}))

const readFileMock = vi.fn()
vi.mock('node:fs/promises', () => ({ default: { readFile: (...a: unknown[]) => readFileMock(...a) } }))

const safeResolveInSessionMock = vi.fn()
vi.mock('@/lib/dev-studio/file-tree', () => ({
  safeResolveInSession: (...args: unknown[]) => safeResolveInSessionMock(...args),
}))

function authedOwner(approved: {
  libraries: string[]
  domains: string[]
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
    approvedDependencies: approved,
  })
}

function getReq(): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/dependencies')
}

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }

describe('GET /sessions/:sessionId/dependencies', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    readManifestFromSession.mockReset()
    getSandboxSettings.mockReset()
    readFileMock.mockReset()
    safeResolveInSessionMock.mockReset()
    getSandboxSettings.mockResolvedValue({
      presetPythonPackages: ['numpy'],      allowedIps: [],
      allowedDomains: [],
      egressMode: 'unrestricted',
    })
    // Default: no file reads needed unless a test sets up manifest.files
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    safeResolveInSessionMock.mockReturnValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    expect((await GET(getReq(), ctx)).status).toBe(401)
  })

  it('returns 404 cross-user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { GET } = await import('./route')
    expect((await GET(getReq(), ctx)).status).toBe(404)
  })

  it('returns empty payload when no manifest exists yet', async () => {
    authedOwner({ libraries: [], domains: [] })
    readManifestFromSession.mockResolvedValue(null)
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body).toEqual({
      libraries: [],
      pendingLibraries: [],
      domains: [],
      ips: [],
      globals: [],
      needsReview: false,
      scannedDomains: [],
      scannedIps: [],
    })
  })

  it('parses libraries into name/version/raw and surfaces globals', async () => {
    authedOwner({ libraries: [], domains: [] })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5', 'requests'], domains: ['api.example.com'], ips: [] },
      files: [],
    })
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.libraries).toEqual([
      { name: 'markdown', version: '>=3.5', raw: 'markdown>=3.5' },
      { name: 'requests', version: '', raw: 'requests' },
    ])
    expect(body.domains).toEqual(['api.example.com'])
    expect(body.globals).toEqual(['numpy'])
    expect(body.needsReview).toBe(true)
    // none approved, neither is a global preset → both pending
    expect(body.pendingLibraries).toEqual([
      { name: 'markdown', version: '>=3.5', raw: 'markdown>=3.5' },
      { name: 'requests', version: '', raw: 'requests' },
    ])
  })

  it('needsReview is false when the only manifest lib is covered by a global preset', async () => {
    authedOwner({ libraries: [], domains: [] })
    getSandboxSettings.mockResolvedValue({
      presetPythonPackages: ['markdown'],
      allowedIps: [],
      allowedDomains: [],
      egressMode: 'unrestricted',
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5'], domains: [], ips: [] },
      files: [],
    })
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    // still listed in full deps (visibility) but not pending → no gate
    expect(body.libraries).toEqual([{ name: 'markdown', version: '>=3.5', raw: 'markdown>=3.5' }])
    expect(body.pendingLibraries).toEqual([])
    expect(body.needsReview).toBe(false)
  })

  it('needsReview is false when every manifest dep is already approved', async () => {
    authedOwner({ libraries: ['markdown>=3.5'], domains: [] })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: ['markdown>=3.5'], domains: [], ips: [] },
      files: [],
    })
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.needsReview).toBe(false)
  })

  it('surfaces manifest ips as pending when not yet approved', async () => {
    // manifest.dependencies.ips = ['10.0.0.5'], approved.ips = []
    authedOwner({ libraries: [], domains: [] })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: ['10.0.0.5'] },
      files: [],
    })
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.ips).toContain('10.0.0.5')
    expect(body.needsReview).toBe(true)
  })

  it('returns 200 and still scans other files when one file read fails', async () => {
    // Authed owner with no approved dependencies
    authedOwner({ libraries: [], domains: [] })
    // Manifest lists two source files; one will fail to read
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
      files: ['bad.py', 'good.py'],
    })
    getSandboxSettings.mockResolvedValue({
      egressMode: 'allowlist',
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
    })
    // Both files resolve to real paths so readFile is actually called for each
    safeResolveInSessionMock.mockImplementation((sessionId: string, rel: string) => `/ws/${rel}`)
    // First call (bad.py) rejects; second call (good.py) succeeds with a domain reference
    readFileMock
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValueOnce('requests.get("https://wttr.in/x")')
    const { GET } = await import('./route')
    const res = await GET(getReq(), ctx)
    // A single failing file must not cause the whole request to 500
    expect(res.status).toBe(200)
    const body = await res.json()
    // The successfully-read file must still be scanned
    expect(body.scannedDomains).toContain('wttr.in')
  })

  it('surfaces a domain used in code but absent from the manifest', async () => {
    // authed owner; approvedDependencies all empty
    authedOwner({ libraries: [], domains: [] })
    // manifest has no domains declared, but the source file reaches wttr.in
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
      files: ['main.py'],
    })
    getSandboxSettings.mockResolvedValue({
      egressMode: 'allowlist',
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
    })
    safeResolveInSessionMock.mockReturnValue('/ws/main.py')
    readFileMock.mockResolvedValue('requests.get("https://wttr.in/x")')
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.scannedDomains).toContain('wttr.in')
    expect(body.domains).toContain('wttr.in')
    expect(body.needsReview).toBe(true)
  })

  it('excludes a rejected scanned domain from pending so needsReview becomes false', async () => {
    // Session has evil.com in rejectedDomains; manifest has none; scanner finds evil.com
    authedOwner({
      libraries: [],
      domains: [],
      ips: [],
      rejectedDomains: ['evil.com'],
      rejectedIps: [],
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: [] },
      files: ['main.py'],
    })
    getSandboxSettings.mockResolvedValue({
      egressMode: 'allowlist',
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
    })
    safeResolveInSessionMock.mockReturnValue('/ws/main.py')
    readFileMock.mockResolvedValue('requests.get("https://evil.com/api")')
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    // Scan must still surface evil.com in scannedDomains (raw scanner output)
    expect(body.scannedDomains).toContain('evil.com')
    // But it must not appear in pendingDomains, so needsReview stays false
    expect(body.needsReview).toBe(false)
  })

  it('excludes a rejected scanned IP from pending so needsReview becomes false', async () => {
    authedOwner({
      libraries: [],
      domains: [],
      ips: [],
      rejectedDomains: [],
      rejectedIps: ['1.2.3.4'],
    })
    readManifestFromSession.mockResolvedValue({
      dependencies: { libraries: [], domains: [], ips: ['1.2.3.4'] },
      files: [],
    })
    getSandboxSettings.mockResolvedValue({
      egressMode: 'allowlist',
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
    })
    const { GET } = await import('./route')
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.needsReview).toBe(false)
  })
})
