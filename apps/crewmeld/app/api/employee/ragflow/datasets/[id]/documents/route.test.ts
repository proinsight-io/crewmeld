import { beforeEach, describe, expect, it, vi } from 'vitest'

const ragflow = {
  loadRagflowConfig: vi.fn(async () => ({ endpoint: 'http://ragflow', apiKey: 'secret' })),
  uploadDocument: vi.fn(async () => [{ id: 'doc-1' }]),
  parseDocuments: vi.fn(async () => undefined),
}
const findByDatasetIds = vi.fn()
const extractImages = vi.fn()
const replaceImages = vi.fn(async () => undefined)
const enqueueBinding = vi.fn(async () => true)

vi.mock('@/lib/ragflow', () => ({
  ...ragflow,
  listDocuments: vi.fn(),
  RagflowClientError: class extends Error {},
}))
vi.mock('@/lib/ragflow/knowledge-metadata-repository', () => ({
  knowledgeMetadataRepository: { findByDatasetIds },
}))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))
vi.mock('@/lib/audit/with-audit', () => ({ withAudit: (handler: unknown) => handler }))
vi.mock('@/lib/knowledge/document-images/docx-extractor', () => ({
  extractDocxAnchoredImages: extractImages,
}))
vi.mock('@/lib/knowledge/document-images/repository', () => ({
  replaceDocumentImages: replaceImages,
}))
vi.mock('@/lib/knowledge/document-images/binding-queue', () => ({
  enqueueDocumentImageBinding: enqueueBinding,
}))

describe('RAGFlow document upload route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('queues generation one only after pending DOCX images and parsing succeed', async () => {
    findByDatasetIds.mockResolvedValue([{ ragflowDatasetId: 'doc-id', type: 'document' }])
    const images = [{ id: 'extracted' }]
    extractImages.mockResolvedValue(images)
    const events: string[] = []
    replaceImages.mockImplementation(async () => { events.push('replace') })
    ragflow.parseDocuments.mockImplementation(async () => { events.push('parse') })
    enqueueBinding.mockImplementation(async () => { events.push('enqueue'); return true })
    const { POST } = await import('./route')
    const body = new FormData()
    body.append('file', new File(['docx'], 'manual.docx'))

    const response = await POST(
      new Request('http://localhost/upload', { method: 'POST', body }) as never,
      { params: Promise.resolve({ id: 'doc-id' }) }
    )

    expect(response.status).toBe(201)
    expect(replaceImages).toHaveBeenCalledWith('doc-id', 'doc-1', images)
    expect(enqueueBinding).toHaveBeenCalledWith('doc-id', 'doc-1', 1)
    expect(events).toEqual(['replace', 'parse', 'enqueue'])
  })

  it('rejects direct QA upload using production metadata with a stable code', async () => {
    findByDatasetIds.mockResolvedValue([{ ragflowDatasetId: 'qa-id', type: 'qa' }])
    const { POST } = await import('./route')
    const body = new FormData()
    body.append('file', new File(['question,answer\nQ,A'], 'qa.csv', { type: 'text/csv' }))
    const response = await POST(
      new Request('http://localhost/upload', { method: 'POST', body }) as never,
      { params: Promise.resolve({ id: 'qa-id' }) }
    )
    const json = await response.json()
    expect(response.status).toBe(409)
    expect(json.code).toBe('QA_DIRECT_UPLOAD_FORBIDDEN')
    expect(ragflow.uploadDocument).not.toHaveBeenCalled()
  })

  it('retains non-CSV document upload and parsing behavior', async () => {
    findByDatasetIds.mockResolvedValue([{ ragflowDatasetId: 'doc-id', type: 'document' }])
    const { POST } = await import('./route')
    const body = new FormData()
    body.append('file', new File(['pdf'], 'manual.pdf', { type: 'application/pdf' }))
    const response = await POST(
      new Request('http://localhost/upload', { method: 'POST', body }) as never,
      { params: Promise.resolve({ id: 'doc-id' }) }
    )
    expect(response.status).toBe(201)
    expect(ragflow.uploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'doc-id',
      expect.any(File),
      'manual.pdf'
    )
    expect(ragflow.parseDocuments).toHaveBeenCalledWith(expect.anything(), 'doc-id', ['doc-1'])
  })
})
