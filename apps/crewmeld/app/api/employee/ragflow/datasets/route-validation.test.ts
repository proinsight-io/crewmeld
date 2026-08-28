import { expect, it, vi } from 'vitest'

const remoteCreate = vi.fn()
vi.mock('@/lib/ragflow', () => ({
  createDataset: remoteCreate,
  deleteDataset: vi.fn(),
  getDataset: vi.fn(),
  listDatasets: vi.fn(),
  loadRagflowConfig: vi.fn(async () => ({ endpoint: 'http://ragflow', apiKey: 'secret', timeoutMs: 1000 })),
  DEFAULT_PARSER_CONFIG: {},
  RagflowClientError: class extends Error {},
  RagflowErrorType: { ConfigMissing: 'CONFIG_MISSING' },
  updateDataset: vi.fn(),
}))
vi.mock('@/lib/ragflow/knowledge-metadata-repository', () => ({ knowledgeMetadataRepository: {} }))
vi.mock('@crewmeld/db/schema', () => ({}))
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: vi.fn(async () => ({ authenticated: true, error: null })),
}))
vi.mock('@/lib/audit/with-audit', () => ({ withAudit: (handler: unknown) => handler }))

it('maps real POST threshold validation to stable HTTP 400 before remote creation', async () => {
  const { POST } = await import('./route')
  const response = await POST(new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify({ name: 'KB', thresholdOverride: 1.01 }),
  }) as never)
  const body = await response.json()

  expect(response.status).toBe(400)
  expect(body.code).toBe('KNOWLEDGE_BASE_THRESHOLD_INVALID')
  expect(remoteCreate).not.toHaveBeenCalled()
})
