/**
 * @vitest-environment node
 *
 * Tests for the per-file session io routes: POST (upload), GET (download),
 * DELETE. Filesystem operations hit a real tmp BFF root; only the auth +
 * session-store boundaries are mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

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

const SESSION_ID = 'sess-file-1'
const CREATED_AT = new Date(Date.UTC(2026, 4, 29, 0, 0, 0))

let bffRoot: string

beforeEach(() => {
  bffRoot = mkdtempSync(path.join(tmpdir(), 'ds-io-file-test-'))
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

function makeCtx(name: string) {
  return { params: Promise.resolve({ sessionId: SESSION_ID, name }) }
}

function authOK(userId = 'u1'): void {
  mockGetCurrentUserRole.mockResolvedValue({ authenticated: true, userId })
}

function sessionOwnedBy(userId: string): void {
  storeGet.mockResolvedValue({ id: SESSION_ID, userId, createdAt: CREATED_AT })
}

/**
 * Build a NextRequest-compatible Request whose body is a multipart/form-data
 * payload containing a single `file` field with the given bytes. Returned as
 * `NextRequest` so the route's typed parameter accepts it; functionally it is
 * a plain Web Request — the route only calls `req.formData()`.
 */
function multipartRequest(filename: string, bytes: string | Uint8Array): NextRequest {
  const fd = new FormData()
  const blob = typeof bytes === 'string' ? new Blob([bytes]) : new Blob([bytes as BlobPart])
  fd.append('file', new File([blob], filename))
  return new Request(`http://test/api/employee/dev-studio/sessions/${SESSION_ID}/io/${filename}`, {
    method: 'POST',
    body: fd,
  }) as unknown as NextRequest
}

describe('POST /api/employee/dev-studio/sessions/[sessionId]/io/[name]', () => {
  it('401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({ authenticated: false, userId: null })
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('a.txt', 'x'), makeCtx('a.txt'))
    expect(res.status).toBe(401)
  })

  it('404 when session not found', async () => {
    authOK()
    storeGet.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('a.txt', 'x'), makeCtx('a.txt'))
    expect(res.status).toBe(404)
  })

  it('404 when session owned by another user', async () => {
    authOK('u1')
    sessionOwnedBy('other')
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('a.txt', 'x'), makeCtx('a.txt'))
    expect(res.status).toBe(404)
  })

  it('400 on path-traversal filename', async () => {
    authOK()
    sessionOwnedBy('u1')
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('../escape', 'x'), makeCtx('..%2Fescape'))
    expect(res.status).toBe(400)
  })

  it('400 on leading-dot filename', async () => {
    authOK()
    sessionOwnedBy('u1')
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('.hidden', 'x'), makeCtx('.hidden'))
    expect(res.status).toBe(400)
  })

  it('400 when no file field in multipart body', async () => {
    authOK()
    sessionOwnedBy('u1')
    const req = new Request(`http://test/foo`, {
      method: 'POST',
      body: new FormData(),
    }) as unknown as NextRequest
    const { POST } = await import('./route')
    const res = await POST(req, makeCtx('a.txt'))
    expect(res.status).toBe(400)
  })

  it('writes the file under sessionIo and reports the size back', async () => {
    authOK()
    sessionOwnedBy('u1')
    const { POST } = await import('./route')
    const res = await POST(multipartRequest('input.pdf', 'PDF-1.4 fake'), makeCtx('input.pdf'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filename: string; size: number }
    expect(body).toEqual({ filename: 'input.pdf', size: 'PDF-1.4 fake'.length })

    const written = await fs.readFile(path.join(ioDir(), 'input.pdf'), 'utf-8')
    expect(written).toBe('PDF-1.4 fake')
  })

  it('overwrites an existing file at the same name', async () => {
    authOK()
    sessionOwnedBy('u1')
    await fs.mkdir(ioDir(), { recursive: true })
    await fs.writeFile(path.join(ioDir(), 'input.pdf'), 'old')

    const { POST } = await import('./route')
    const res = await POST(multipartRequest('input.pdf', 'new'), makeCtx('input.pdf'))
    expect(res.status).toBe(200)
    const written = await fs.readFile(path.join(ioDir(), 'input.pdf'), 'utf-8')
    expect(written).toBe('new')
  })
})

describe('GET /api/employee/dev-studio/sessions/[sessionId]/io/[name]', () => {
  it('streams the file with extension-derived mime', async () => {
    authOK()
    sessionOwnedBy('u1')
    await fs.mkdir(ioDir(), { recursive: true })
    await fs.writeFile(path.join(ioDir(), 'doc.pdf'), 'fake-pdf')

    const { GET } = await import('./route')
    const req = new Request('http://test/foo') as unknown as NextRequest
    const res = await GET(req, makeCtx('doc.pdf'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('doc.pdf')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(new TextDecoder().decode(buf)).toBe('fake-pdf')
  })

  it('404 when the file does not exist', async () => {
    authOK()
    sessionOwnedBy('u1')
    const { GET } = await import('./route')
    const req = new Request('http://test/foo') as unknown as NextRequest
    const res = await GET(req, makeCtx('missing.txt'))
    expect(res.status).toBe(404)
  })

  it('404 when session owned by another user', async () => {
    authOK('u1')
    sessionOwnedBy('other')
    const { GET } = await import('./route')
    const req = new Request('http://test/foo') as unknown as NextRequest
    const res = await GET(req, makeCtx('doc.pdf'))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/employee/dev-studio/sessions/[sessionId]/io/[name]', () => {
  it('removes the file and reports deleted:true', async () => {
    authOK()
    sessionOwnedBy('u1')
    await fs.mkdir(ioDir(), { recursive: true })
    await fs.writeFile(path.join(ioDir(), 'gone.txt'), 'x')

    const { DELETE } = await import('./route')
    const req = new Request('http://test/foo', { method: 'DELETE' }) as unknown as NextRequest
    const res = await DELETE(req, makeCtx('gone.txt'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true })
    await expect(fs.stat(path.join(ioDir(), 'gone.txt'))).rejects.toThrow()
  })

  it('returns deleted:false when the file is already gone (idempotent)', async () => {
    authOK()
    sessionOwnedBy('u1')
    const { DELETE } = await import('./route')
    const req = new Request('http://test/foo', { method: 'DELETE' }) as unknown as NextRequest
    const res = await DELETE(req, makeCtx('missing.txt'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: false })
  })

  it('404 when session owned by another user', async () => {
    authOK('u1')
    sessionOwnedBy('other')
    const { DELETE } = await import('./route')
    const req = new Request('http://test/foo', { method: 'DELETE' }) as unknown as NextRequest
    const res = await DELETE(req, makeCtx('gone.txt'))
    expect(res.status).toBe(404)
  })
})
