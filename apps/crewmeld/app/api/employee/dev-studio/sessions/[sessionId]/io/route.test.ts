/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/sessions/[sessionId]/io — list the
 * operator's persistent run-test inputs. Walks the real filesystem at a
 * tmp BFF root; mocks only the auth + session-store boundaries.
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

const SESSION_ID = 'sess-list-1'
const CREATED_AT = new Date(Date.UTC(2026, 4, 29, 0, 0, 0))

let bffRoot: string

beforeEach(() => {
  bffRoot = mkdtempSync(path.join(tmpdir(), 'ds-io-list-test-'))
  process.env.CREWMELD_BFF_VOLUME_ROOT = bffRoot
  process.env.CREWMELD_SANDBOX_VOLUME_ROOT = '/data/opensandbox-deploy'

  mockGetCurrentUserRole.mockReset()
  storeGet.mockReset()
})

afterEach(() => {
  rmSync(bffRoot, { recursive: true, force: true })
})

function ioDir(): string {
  return path.join(bffRoot, 'io', 'session', '2026', '05', '29', SESSION_ID)
}

function makeReq(): Request {
  return new Request(`http://test/api/employee/dev-studio/sessions/${SESSION_ID}/io`)
}

function makeCtx() {
  return { params: Promise.resolve({ sessionId: SESSION_ID }) }
}

describe('GET /api/employee/dev-studio/sessions/[sessionId]/io', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: false, userId: null })
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 when session does not exist', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: true, userId: 'u1' })
    storeGet.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to another user (no info leak)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: true, userId: 'u1' })
    storeGet.mockResolvedValue({ id: SESSION_ID, userId: 'other', createdAt: CREATED_AT })
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('returns empty list when io dir does not exist (fresh session)', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: true, userId: 'u1' })
    storeGet.mockResolvedValue({ id: SESSION_ID, userId: 'u1', createdAt: CREATED_AT })
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [] })
  })

  it('returns flat files sorted by name, ignoring subdirectories', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: true, userId: 'u1' })
    storeGet.mockResolvedValue({ id: SESSION_ID, userId: 'u1', createdAt: CREATED_AT })

    await fs.mkdir(ioDir(), { recursive: true })
    await fs.writeFile(path.join(ioDir(), 'zeta.txt'), 'z')
    await fs.writeFile(path.join(ioDir(), 'alpha.pdf'), 'pdf')
    await fs.mkdir(path.join(ioDir(), 'nested'), { recursive: true })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ name: string; size: number }> }
    expect(body.files.map((f) => f.name)).toEqual(['alpha.pdf', 'zeta.txt'])
    expect(body.files[0].size).toBe(3)
  })
})
