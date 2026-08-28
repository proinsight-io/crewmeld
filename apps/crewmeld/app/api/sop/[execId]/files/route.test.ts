/**
 * @vitest-environment node
 *
 * Tests for GET /api/sop/[execId]/files (list). NFS path uses a real tmp
 * dir; MinIO is mocked. The route's auth model is "capability URL" so no
 * session mocking required.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  bffRoot = mkdtempSync(path.join(tmpdir(), 'sop-files-list-test-'))
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

function makeCtx() {
  return { params: Promise.resolve({ execId: SOP_EXEC_ID }) }
}

describe('GET /api/sop/[execId]/files', () => {
  it('400 on invalid execId format', async () => {
    const { GET } = await import('./route')
    const res = await GET(makeReq(), {
      params: Promise.resolve({ execId: 'short' }),
    })
    expect(res.status).toBe(400)
    expect(minioSend).not.toHaveBeenCalled()
  })

  it('returns NFS-only files when MinIO yields nothing', async () => {
    minioSend.mockResolvedValue({ Contents: [] })
    await fs.mkdir(sopDir(), { recursive: true })
    await fs.writeFile(path.join(sopDir(), 'output.png'), 'png-bytes')

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{ name: string; source: string }>
    }
    expect(body.files.map((f) => f.name)).toEqual(['output.png'])
    expect(body.files[0].source).toBe('nfs')
  })

  it('merges NFS + MinIO entries, sorted by name', async () => {
    minioSend.mockResolvedValue({
      Contents: [
        { Key: 'sop/' + SOP_EXEC_ID + '/legacy-k8s.csv', Size: 5, LastModified: new Date() },
      ],
    })
    await fs.mkdir(sopDir(), { recursive: true })
    await fs.writeFile(path.join(sopDir(), 'dev-studio.png'), 'p')

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    const body = (await res.json()) as {
      files: Array<{ name: string; source: string }>
    }
    expect(body.files.map((f) => f.name)).toEqual(['dev-studio.png', 'legacy-k8s.csv'])
    const dev = body.files.find((f) => f.name === 'dev-studio.png')
    const legacy = body.files.find((f) => f.name === 'legacy-k8s.csv')
    expect(dev?.source).toBe('nfs')
    expect(legacy?.source).toBe('minio')
  })

  it('NFS wins on name collision (fresher than rclone-asynced MinIO copy)', async () => {
    minioSend.mockResolvedValue({
      Contents: [{ Key: 'sop/' + SOP_EXEC_ID + '/shared.png', Size: 99, LastModified: new Date() }],
    })
    await fs.mkdir(sopDir(), { recursive: true })
    await fs.writeFile(path.join(sopDir(), 'shared.png'), 'nfs-1234')

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    const body = (await res.json()) as {
      files: Array<{ name: string; source: string; size: number }>
    }
    expect(body.files).toHaveLength(1)
    expect(body.files[0].source).toBe('nfs')
    expect(body.files[0].size).toBe(8) // length of 'nfs-1234'
  })

  it('still returns NFS results when MinIO list throws', async () => {
    minioSend.mockRejectedValue(new Error('MinIO down'))
    await fs.mkdir(sopDir(), { recursive: true })
    await fs.writeFile(path.join(sopDir(), 'output.png'), 'x')

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ name: string }> }
    expect(body.files.map((f) => f.name)).toEqual(['output.png'])
  })

  it('empty 200 list when neither backend has anything', async () => {
    minioSend.mockResolvedValue({ Contents: [] })

    const { GET } = await import('./route')
    const res = await GET(makeReq(), makeCtx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: unknown[] }
    expect(body.files).toEqual([])
  })
})
