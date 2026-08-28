import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requirePermissionMock, findImageMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(),
  findImageMock: vi.fn(),
}))

vi.mock('@/lib/auth/rbac/check-permission', () => ({ requirePermission: requirePermissionMock }))
vi.mock('@/lib/knowledge/document-images/repository', () => ({
  findDocumentImageById: findImageMock,
}))

import { GET } from './route'

describe('document image GET', () => {
  beforeEach(() => {
    requirePermissionMock.mockReset()
    findImageMock.mockReset()
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: null })
  })

  it('returns the exact stored image bytes behind knowledge permission', async () => {
    findImageMock.mockResolvedValue({ mimeType: 'image/png', contentBase64: Buffer.from([1, 2, 3]).toString('base64') })
    const response = await GET(new Request('http://localhost') as never, {
      params: Promise.resolve({ imageId: 'image-1' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it('returns 404 for an unknown image', async () => {
    findImageMock.mockResolvedValue(null)
    const response = await GET(new Request('http://localhost') as never, {
      params: Promise.resolve({ imageId: 'missing' }),
    })
    expect(response.status).toBe(404)
  })
})
