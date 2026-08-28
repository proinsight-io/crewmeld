import { beforeEach, describe, expect, it, vi } from 'vitest'

const events: string[] = []
const stopDocumentsParsing = vi.fn(async () => undefined)
const parseDocuments = vi.fn(async () => { events.push('parse') })
const invalidateBindings = vi.fn(async (documentId: string) => {
  events.push(`invalidate:${documentId}`)
  return documentId === 'doc-without-images' ? 0 : 4
})
const enqueueBinding = vi.fn(async (_datasetId: string, documentId: string) => {
  events.push(`enqueue:${documentId}`)
  return true
})

vi.mock('@/lib/ragflow', () => ({
  loadRagflowConfig: vi.fn(async () => ({})),
  parseDocuments,
  stopDocumentsParsing,
  RagflowClientError: class extends Error {},
}))
vi.mock('@/lib/knowledge/document-images/repository', () => ({
  invalidateDocumentImageBindings: invalidateBindings,
}))
vi.mock('@/lib/knowledge/document-images/binding-queue', () => ({
  enqueueDocumentImageBinding: enqueueBinding,
}))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))
vi.mock('@/lib/audit/with-audit', () => ({ withAudit: (handler: unknown) => handler }))

describe('RAGFlow manual parse route image rebinding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    events.length = 0
  })

  it('invalidates old bindings before parsing and queues current generations afterward', async () => {
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://localhost/parse', {
        method: 'POST',
        body: JSON.stringify({ documentIds: ['doc-1', 'doc-without-images'] }),
      }) as never,
      { params: Promise.resolve({ id: 'dataset-1' }) }
    )

    expect(response.status).toBe(200)
    expect(events).toEqual([
      'invalidate:doc-1',
      'invalidate:doc-without-images',
      'parse',
      'enqueue:doc-1',
    ])
    expect(enqueueBinding).toHaveBeenCalledWith('dataset-1', 'doc-1', 4)
  })

  it('does not queue when the RAGFlow parse trigger fails after invalidation', async () => {
    parseDocuments.mockRejectedValueOnce(new Error('parse failed'))
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://localhost/parse', {
        method: 'POST',
        body: JSON.stringify({ documentIds: ['doc-1'] }),
      }) as never,
      { params: Promise.resolve({ id: 'dataset-1' }) }
    )

    expect(response.status).toBe(500)
    expect(invalidateBindings).toHaveBeenCalledWith('doc-1')
    expect(enqueueBinding).not.toHaveBeenCalled()
  })
})
