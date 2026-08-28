/**
 * @vitest-environment node
 *
 * Tests for GET /api/sop/[execId]/files/[name]. The post-Plan-B route tries
 * NFS first (dev-studio tools) and falls back to MinIO (legacy K8s tools).
 * These tests cover both paths plus the validation guards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const minioSend = vi.fn()
vi.mock('@/lib/storage/minio-client', () => ({
  getMinioClient: () => ({ send: minioSend }),
  MINIO_BUCKET: 'test-bucket',
}))

const SOP_EXEC_ID = 'sop_20260601_aabbccddeeff'

let bffRoot: string

beforeEach(() => {
  bffRoot = mkdtempSync(path.join(tmpdir(), 'sop-files-get-test-'))
  process.env.CREWMELD_BFF_VOLUME_ROOT = bffRoot
  process.env.CREWMELD_SANDBOX_VOLUME_ROOT = '/data/opensandbox-deploy'
  minioSend.mockReset()
})

afterEach(() => {
  rmSync(bffRoot, { recursive: true, force: true })
})

function sopDir(): string {
  return path.join(bffRoot, 'sop-files', '2026', '06', '01', SOP_EXEC_ID)
}

function makeReq(): NextRequest {
  return new Request('http://test/foo') as unknown as NextRequest
}

function makeCtx(name: string) {
  return { params: Promise.resolve({ execId: SOP_EXEC_ID, name }) }
}

describe('GET /api/sop/[execId]/files/[name]', () => {
  it('400 on invalid execId format', async () => {
    const { GET } = await import('./route')
    const res = await GET(makeReq(), {
      params: Promise.resolve({ execId: 'short', name: 'a.txt' }),
    })
    expect(res.status).toBe(400)
    expect(minioSend).not.toHaveBeenCalled()
  })

  it('400 on filename with path traversal sentinel', async () => {
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('..'))
    expect(res.status).toBe(400)
  })

  it('400 on filename containing /', async () => {
    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('a%2Fb.txt'))
    expect(res.status).toBe(400)
  })

  it('serves the NFS file directly without hitting MinIO', async () => {
    await fs.mkdir(sopDir(), { recursive: true })
    await fs.writeFile(path.join(sopDir(), 'output.png'), 'fake-png')

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('output.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe('8')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(new TextDecoder().decode(buf)).toBe('fake-png')
    expect(minioSend).not.toHaveBeenCalled()
  })

  it('falls back to MinIO when the NFS file is missing', async () => {
    minioSend.mockResolvedValue({
      Body: Readable.from([Buffer.from('legacy-bytes')]),
      ContentType: 'text/csv',
      ContentLength: 12,
    })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('legacy.csv'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(minioSend).toHaveBeenCalledTimes(1)
  })

  it('404 when neither backend has the file', async () => {
    minioSend.mockResolvedValue({ Body: null })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('gone.txt'))
    expect(res.status).toBe(404)
  })

  it('404 when MinIO throws NoSuchKey', async () => {
    const err = new Error('NoSuchKey')
    err.name = 'NoSuchKey'
    minioSend.mockRejectedValue(err)

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('gone.txt'))
    expect(res.status).toBe(404)
  })

  it('500 when MinIO throws an unexpected error after NFS miss', async () => {
    minioSend.mockRejectedValue(new Error('connection refused'))

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx('gone.txt'))
    expect(res.status).toBe(500)
  })
})
