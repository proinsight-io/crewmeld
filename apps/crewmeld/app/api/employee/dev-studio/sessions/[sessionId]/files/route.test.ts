/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/sessions/:sessionId/files.
 *
 * Walks the live workspace dir via the real `buildFileTree`; mocks only the
 * auth and session-store boundaries. Hidden directories (`.dev-studio`,
 * `.git`) MUST be filtered out so AI bookkeeping never leaks to the UI.
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

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: TreeNode[]
}

let workspaceDir: string

beforeEach(async () => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'ds-files-route-test-'))
  await fs.writeFile(path.join(workspaceDir, 'main.py'), 'print("hi")\n', 'utf-8')
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspaceDir, 'src', 'a.ts'), 'export const a = 1\n', 'utf-8')
  await fs.mkdir(path.join(workspaceDir, '.dev-studio'), { recursive: true })
  await fs.writeFile(path.join(workspaceDir, '.dev-studio', 'manifest.json'), '{}', 'utf-8')
  await fs.mkdir(path.join(workspaceDir, '.git'), { recursive: true })
  await fs.writeFile(path.join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')

  mockGetCurrentUserRole.mockReset()
  storeGet.mockReset()
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('GET /api/employee/dev-studio/sessions/:sessionId/files', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/files'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
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
      new Request('http://test/api/employee/dev-studio/sessions/missing/files'),
      { params: Promise.resolve({ sessionId: 'missing' }) }
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
      userId: 'other-user',
      status: 'active',
      workspaceDir,
    })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/files'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns the workspace tree, filtering hidden dirs (.dev-studio, .git)', async () => {
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
    const { GET } = await import('./route')
    const res = await GET(new Request('http://test/api/employee/dev-studio/sessions/s1/files'), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tree: TreeNode }
    expect(body.tree.type).toBe('directory')
    const childNames = (body.tree.children ?? []).map((c) => c.name).sort()
    expect(childNames).toEqual(['main.py', 'src'])
    // Hidden entries pruned.
    expect(childNames).not.toContain('.dev-studio')
    expect(childNames).not.toContain('.git')
    // src/ has a.ts inside.
    const src = body.tree.children?.find((c) => c.name === 'src')
    expect(src?.type).toBe('directory')
    expect(src?.children?.[0]?.name).toBe('a.ts')
  })
})
