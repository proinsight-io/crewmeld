import { beforeEach, describe, expect, it, vi } from 'vitest'

const ragflow = {
  createDataset: vi.fn(),
  deleteDataset: vi.fn(),
  getDataset: vi.fn(),
  listDatasets: vi.fn(),
  loadRagflowConfig: vi.fn(async () => ({ endpoint: 'http://ragflow', apiKey: 'secret', timeoutMs: 1000 })),
  updateDataset: vi.fn(),
}
const metadata = {
  createDatasetWithMetadata: vi.fn(),
  reconcileAndMergeDatasetMetadata: vi.fn(),
  updateKnowledgeMetadata: vi.fn(),
}

vi.mock('@/lib/ragflow', () => ({
  ...ragflow,
  DEFAULT_PARSER_CONFIG: {},
  RagflowClientError: class extends Error {},
  RagflowErrorType: { ConfigMissing: 'CONFIG_MISSING' },
}))
vi.mock('@/lib/ragflow/knowledge-metadata', () => ({
  ...metadata,
  ImmutableKnowledgeBaseTypeError: class extends Error { readonly code = 'KNOWLEDGE_BASE_TYPE_IMMUTABLE' },
  InvalidKnowledgeThresholdError: class extends Error { readonly code = 'KNOWLEDGE_BASE_THRESHOLD_INVALID' },
  PartialDatasetCreationError: class extends Error {
    readonly code = 'RAGFLOW_DATASET_METADATA_PARTIAL_FAILURE'
    constructor(readonly datasetId: string) { super('partial failure') }
  },
}))
vi.mock('@/lib/ragflow/knowledge-metadata-repository', () => ({ knowledgeMetadataRepository: {} }))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))
vi.mock('@/lib/audit/with-audit', () => ({ withAudit: (handler: unknown) => handler }))

describe('RAGFlow dataset routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('surfaces legacy list rows as document through metadata merge', async () => {
    ragflow.listDatasets.mockResolvedValue([{ id: 'legacy', name: 'Legacy' }])
    metadata.reconcileAndMergeDatasetMetadata.mockResolvedValue([{ id: 'legacy', name: 'Legacy', metadata: { id: 'local-legacy' }, type: 'document' }])
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/employee/ragflow/datasets') as never)
    const body = await response.json()

    expect(body.data[0].type).toBe('document')
  })

  it('returns metadata on compensated create boundary success', async () => {
    metadata.createDatasetWithMetadata.mockResolvedValue({
      dataset: { id: 'remote-qa', name: 'FAQ' },
      metadata: { ragflowDatasetId: 'remote-qa', type: 'qa' },
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/employee/ragflow/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: 'FAQ', type: 'qa' }),
    }) as never)
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data.type).toBe('qa')
  })

  it('returns the stable partial-failure response when compensation fails', async () => {
    const { PartialDatasetCreationError } = await import('@/lib/ragflow/knowledge-metadata')
    metadata.createDatasetWithMetadata.mockRejectedValue(new PartialDatasetCreationError('remote-orphan'))
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/employee/ragflow/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: 'FAQ', type: 'qa' }),
    }) as never)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.code).toBe('RAGFLOW_DATASET_METADATA_PARTIAL_FAILURE')
  })

  it('surfaces document as the default on dataset detail', async () => {
    ragflow.getDataset.mockResolvedValue({ id: 'legacy', name: 'Legacy' })
    metadata.reconcileAndMergeDatasetMetadata.mockResolvedValue([{ id: 'legacy', name: 'Legacy', metadata: { id: 'local-legacy' }, type: 'document' }])
    const { GET } = await import('./[id]/route')

    const response = await GET(new Request('http://localhost') as never, { params: Promise.resolve({ id: 'legacy' }) })
    const body = await response.json()

    expect(body.data.type).toBe('document')
  })

  it('rejects immutable type PATCH with a stable code', async () => {
    const { ImmutableKnowledgeBaseTypeError } = await import('@/lib/ragflow/knowledge-metadata')
    metadata.updateKnowledgeMetadata.mockRejectedValue(new ImmutableKnowledgeBaseTypeError('immutable'))
    const { PATCH } = await import('./[id]/route')

    const response = await PATCH(new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ type: 'document' }),
    }) as never, { params: Promise.resolve({ id: 'qa-id' }) })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('KNOWLEDGE_BASE_TYPE_IMMUTABLE')
  })
})
