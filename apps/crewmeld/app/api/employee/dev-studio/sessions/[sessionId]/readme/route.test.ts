/**
 * @vitest-environment node
 *
 * Tests for GET + PUT /api/employee/dev-studio/sessions/:sessionId/readme.
 *
 * Boundaries mocked: auth + sessionStore + readme-store. PUT must enforce
 * the 100 KiB cap (413) and bad bodies (400). GET surfaces null as 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
  },
}))

const readReadme = vi.fn()
const writeReadme = vi.fn()
vi.mock('@/lib/dev-studio/readme-store', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/dev-studio/readme-store')>(
      '@/lib/dev-studio/readme-store'
    )
  return {
    ...actual,
    readReadmeFromSession: (...args: unknown[]) => readReadme(...args),
    writeReadmeFromSession: (...args: unknown[]) => writeReadme(...args),
    README_RELATIVE_PATH: '.dev-studio/README.md',
    README_MAX_BYTES: 100 * 1024,
  }
})

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

describe('GET /api/employee/dev-studio/sessions/:sessionId/readme', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    readReadme.mockReset()
    writeReadme.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/readme'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(readReadme).not.toHaveBeenCalled()
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
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/readme'), {
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
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/readme'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the README is absent', async () => {
    authedOwner()
    readReadme.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/readme'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns the markdown body with text/markdown Content-Type', async () => {
    authedOwner()
    readReadme.mockResolvedValue('# hello\n\nworld')
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/readme'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(await res.text()).toBe('# hello\n\nworld')
    expect(readReadme).toHaveBeenCalledWith('s1')
  })
})

describe('PUT /api/employee/dev-studio/sessions/:sessionId/readme', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    readReadme.mockReset()
    writeReadme.mockReset()
  })

  function putReq(body: unknown): Request {
    return new Request('http://test/api/employee/dev-studio/sessions/s1/readme', {
      method: 'PUT',
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
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ markdown: '# x' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(writeReadme).not.toHaveBeenCalled()
  })

  it('returns 404 cross-user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active', workspaceDir: '/ws' })
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ markdown: '# x' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
    expect(writeReadme).not.toHaveBeenCalled()
  })

  it('returns 400 when body is missing markdown', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ other: 'x' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(writeReadme).not.toHaveBeenCalled()
  })

  it('returns 400 when body is not JSON', async () => {
    authedOwner()
    const { PUT } = await import('./route')
    const res = await PUT(
      new Request('http://test/api/employee/dev-studio/sessions/s1/readme', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(400)
    expect(writeReadme).not.toHaveBeenCalled()
  })

  it('returns 413 when the markdown exceeds README_MAX_BYTES', async () => {
    authedOwner()
    writeReadme.mockRejectedValue(new Error('README exceeds 102400 bytes (got 200000)'))
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ markdown: 'big' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(413)
  })

  it('returns 204 on successful write', async () => {
    authedOwner()
    writeReadme.mockResolvedValue(undefined)
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ markdown: '# hi' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(204)
    expect(writeReadme).toHaveBeenCalledWith('s1', '# hi')
  })
})
