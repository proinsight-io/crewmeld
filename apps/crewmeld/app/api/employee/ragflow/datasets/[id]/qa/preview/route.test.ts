import { beforeEach, describe, expect, it, vi } from 'vitest'

const findByDatasetIds = vi.fn()
vi.mock('@/lib/ragflow/knowledge-metadata-repository', () => ({
  knowledgeMetadataRepository: { findByDatasetIds },
}))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))

describe('QA CSV preview route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns server-validated headers, valid rows, and structured errors without importing', async () => {
    findByDatasetIds.mockResolvedValue([{ ragflowDatasetId: 'qa-id', type: 'qa' }])
    const { POST } = await import('./route')
    const body = new FormData()
    body.append(
      'file',
      new File(['question,answer,tags\nQ,A,one\nQ2, ,two'], 'qa.csv', { type: 'text/csv' })
    )

    const response = await POST(
      new Request('http://localhost/preview', { method: 'POST', body }) as never,
      {
        params: Promise.resolve({ id: 'qa-id' }),
      }
    )
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.data.headers).toEqual(['question', 'answer', 'tags'])
    expect(json.data.rows).toEqual([{ row: 2, question: 'Q', answer: 'A', tags: 'one' }])
    expect(json.data.errors).toContainEqual({ code: 'EMPTY_ANSWER', row: 3, field: 'answer' })
  })

  it('rejects preview for a document knowledge base', async () => {
    findByDatasetIds.mockResolvedValue([{ ragflowDatasetId: 'doc-id', type: 'document' }])
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://localhost/preview', { method: 'POST', body: new FormData() }) as never,
      {
        params: Promise.resolve({ id: 'doc-id' }),
      }
    )
    expect(response.status).toBe(409)
  })
})
