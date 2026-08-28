/**
 * @vitest-environment node
 *
 * Tests for GET + PATCH /api/employee/dev-studio/sessions/:sessionId/manifest.
 *
 * Boundaries mocked: auth + sessionStore + manifest-reader (so we can assert
 * call wiring without writing real files).
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

const readManifest = vi.fn()
const patchManifest = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/dev-studio/manifest-reader')>(
      '@/lib/dev-studio/manifest-reader'
    )
  return {
    ...actual,
    readManifestFromSession: (...args: unknown[]) => readManifest(...args),
    patchManifestFromSession: (...args: unknown[]) => patchManifest(...args),
    MANIFEST_RELATIVE_PATH: '.dev-studio/manifest.json',
  }
})

const SAMPLE_MANIFEST = {
  version: '1',
  name: 'demo',
  description: 'demo tool',
  kind: 'script' as const,
  entrypoint: 'main.py',
  dependencies: { libraries: [], domains: [] },
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  input: {},
  output: { type: 'text' as const },
}

function authedOwner() {
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
    workspaceDir: '/ws/s1',
  })
}

describe('GET /api/employee/dev-studio/sessions/:sessionId/manifest', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
    readManifest.mockReset()
    patchManifest.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(readManifest).not.toHaveBeenCalled()
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
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 cross-user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active', workspaceDir: '/ws' })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the manifest file is absent', async () => {
    authedOwner()
    readManifest.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns the manifest payload when present', async () => {
    authedOwner()
    readManifest.mockResolvedValue(SAMPLE_MANIFEST)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: typeof SAMPLE_MANIFEST }
    expect(body.manifest).toEqual(SAMPLE_MANIFEST)
    expect(readManifest).toHaveBeenCalledWith('s1')
  })

  it('names untitled session from manifest.name when title is null', async () => {
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
      workspaceDir: '/ws/s1',
      title: null,
      activeContainerId: null,
    })
    readManifest.mockResolvedValue(SAMPLE_MANIFEST)
    storeUpdate.mockResolvedValue(undefined)

    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    expect(storeUpdate).toHaveBeenCalledWith('s1', { title: 'demo' })
  })

  it('does not overwrite session title when already set', async () => {
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
      workspaceDir: '/ws/s1',
      title: 'existing title',
      activeContainerId: null,
    })
    readManifest.mockResolvedValue(SAMPLE_MANIFEST)

    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/manifest'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    expect(storeUpdate).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/employee/dev-studio/sessions/:sessionId/manifest', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
    readManifest.mockReset()
    patchManifest.mockReset()
  })

  function patchReq(body: unknown): Request {
    return new Request('http://test/api/employee/dev-studio/sessions/s1/manifest', {
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
    const res = await PATCH(patchReq({ name: 'new' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(patchManifest).not.toHaveBeenCalled()
  })

  it('returns 404 cross-user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active', workspaceDir: '/ws' })
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ name: 'new' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
    expect(patchManifest).not.toHaveBeenCalled()
  })

  it('returns 400 when body fails Zod (e.g. name too long)', async () => {
    authedOwner()
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ name: 'a'.repeat(61) }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(patchManifest).not.toHaveBeenCalled()
  })

  it('returns 400 when body is not JSON', async () => {
    authedOwner()
    const { PATCH } = await import('./route')
    const res = await PATCH(
      new Request('http://test/api/employee/dev-studio/sessions/s1/manifest', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(400)
    expect(patchManifest).not.toHaveBeenCalled()
  })

  it('returns 409 when the manifest does not exist yet', async () => {
    authedOwner()
    patchManifest.mockRejectedValue(
      new Error('CONFLICT: manifest does not exist; AI must create it first')
    )
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ name: 'new-name' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns the patched manifest on success', async () => {
    authedOwner()
    const next = { ...SAMPLE_MANIFEST, name: 'new-name', updatedAt: '2025-02-02T00:00:00.000Z' }
    patchManifest.mockResolvedValue(next)
    const { PATCH } = await import('./route')
    const res = await PATCH(patchReq({ name: 'new-name', description: 'updated' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: typeof next }
    expect(body.manifest).toEqual(next)
    expect(patchManifest).toHaveBeenCalledWith('s1', {
      name: 'new-name',
      description: 'updated',
    })
  })
})
