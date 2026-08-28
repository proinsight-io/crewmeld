/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/sessions/:sessionId/files/[...path].
 *
 * Validates auth, ownership, path-traversal rejection, size caps per mime
 * kind (412 with metadata), missing files (404), and successful streaming of
 * text and binary content.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

let workspaceDir: string

beforeEach(async () => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'ds-file-route-test-'))
  await fs.writeFile(path.join(workspaceDir, 'main.py'), 'print("hi")\n', 'utf-8')
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspaceDir, 'src', 'a.ts'), 'export const a = 1\n', 'utf-8')

  mockGetCurrentUserRole.mockReset()
  storeGet.mockReset()
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
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
    workspaceDir,
  })
}

describe('GET /api/employee/dev-studio/sessions/:sessionId/files/[...path]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/main.py'),
      { params: Promise.resolve({ sessionId: 's1', path: ['main.py'] }) }
    )
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
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
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/missing/files/main.py'),
      { params: Promise.resolve({ sessionId: 'missing', path: ['main.py'] }) }
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to a different user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({
      id: 's1',
      userId: 'other',
      status: 'active',
      workspaceDir,
    })
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/main.py'),
      { params: Promise.resolve({ sessionId: 's1', path: ['main.py'] }) }
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for path traversal attempts', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/..%2Fetc%2Fpasswd'),
      { params: Promise.resolve({ sessionId: 's1', path: ['..', 'etc', 'passwd'] }) }
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the file does not exist', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/nope.txt'),
      { params: Promise.resolve({ sessionId: 's1', path: ['nope.txt'] }) }
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when path resolves to a directory (not a file)', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/src'),
      { params: Promise.resolve({ sessionId: 's1', path: ['src'] }) }
    )
    expect(res.status).toBe(404)
  })

  it('streams the file content with correct Content-Type for .py', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/main.py'),
      { params: Promise.resolve({ sessionId: 's1', path: ['main.py'] }) }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/x-python/)
    const text = await res.text()
    expect(text).toBe('print("hi")\n')
  })

  it('streams nested files via the catch-all segments', async () => {
    authedOwner()
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/src/a.ts'),
      { params: Promise.resolve({ sessionId: 's1', path: ['src', 'a.ts'] }) }
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe('export const a = 1\n')
  })

  it('returns 412 with metadata when a text file exceeds the 1 MiB cap', async () => {
    authedOwner()
    // 1 MiB + 1 byte of "a"
    const bigPath = path.join(workspaceDir, 'big.txt')
    await fs.writeFile(bigPath, Buffer.alloc(1024 * 1024 + 1, 0x61))
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/big.txt'),
      { params: Promise.resolve({ sessionId: 's1', path: ['big.txt'] }) }
    )
    expect(res.status).toBe(412)
    expect(res.headers.get('x-file-size')).toBe(String(1024 * 1024 + 1))
    const body = (await res.json()) as { size: number; mime: string; tooLarge: boolean }
    expect(body.tooLarge).toBe(true)
    expect(body.size).toBe(1024 * 1024 + 1)
    expect(body.mime).toMatch(/^text\//)
  })

  it('streams a small PNG with image/png Content-Type', async () => {
    authedOwner()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await fs.writeFile(path.join(workspaceDir, 'pixel.png'), png)
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://test/api/employee/dev-studio/sessions/s1/files/pixel.png'),
      { params: Promise.resolve({ sessionId: 's1', path: ['pixel.png'] }) }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.equals(png)).toBe(true)
  })
})
