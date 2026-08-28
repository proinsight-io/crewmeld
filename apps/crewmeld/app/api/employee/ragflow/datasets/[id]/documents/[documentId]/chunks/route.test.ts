import { describe, expect, it, vi } from 'vitest'

const getDocumentChunks = vi.fn(async () => ({
  chunks: [
    { id: 'chunk-1', content: 'content', document_id: 'doc-1', document_name: 'doc', dataset_id: 'ds-1' },
  ],
  doc: { id: 'doc-1', run: '3' },
  total: 1,
}))
const findBoundImages = vi.fn(async () => [
  { id: 'image-1', documentId: 'doc-1', boundChunkId: 'chunk-1', mimeType: 'image/png', sortOrder: 0 },
])
const findPendingGeneration = vi.fn(async () => 3)
const enqueueBinding = vi.fn(async () => true)

vi.mock('@/lib/ragflow', () => ({
  getDocumentChunks,
  loadRagflowConfig: vi.fn(async () => ({})),
  RagflowClientError: class extends Error {},
}))
vi.mock('@/lib/knowledge/document-images/repository', () => ({
  findBoundDocumentImages: findBoundImages,
  findPendingImageBindingGeneration: findPendingGeneration,
}))
vi.mock('@/lib/knowledge/document-images/binding-queue', () => ({
  enqueueDocumentImageBinding: enqueueBinding,
}))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))

describe('RAGFlow chunk route image binding', () => {
  it('attaches exact images and repairs a completed pending document', async () => {
    const { GET } = await import('./route')
    const response = await GET(
      new Request('http://localhost/chunks?page=1&pageSize=20') as never,
      { params: Promise.resolve({ id: 'ds-1', documentId: 'doc-1' }) }
    )
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(findBoundImages).toHaveBeenCalledWith(['chunk-1'])
    expect(json.data.chunks[0].images[0].id).toBe('image-1')
    expect(enqueueBinding).toHaveBeenCalledWith('ds-1', 'doc-1', 3)
  })
})
