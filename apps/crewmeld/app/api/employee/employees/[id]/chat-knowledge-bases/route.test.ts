import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }))
const requirePermissionMock = vi.fn()
const listDatasetsMock = vi.fn()

vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}))

vi.mock('@/lib/ragflow', () => ({
  loadRagflowConfig: vi.fn().mockResolvedValue({}),
  listDatasets: (...args: unknown[]) => listDatasetsMock(...args),
}))

vi.mock('@/lib/ragflow/knowledge-metadata', () => ({
  reconcileAndMergeDatasetMetadata: vi.fn(),
}))

vi.mock('@/lib/ragflow/knowledge-metadata-repository', () => ({
  knowledgeMetadataRepository: {},
}))

vi.mock('@/lib/conversation/chat-knowledge', () => ({
  filterEmployeeDatasets: vi.fn(),
}))

vi.mock('@crewmeld/logger', () => ({
  createLogger: () => ({ error: loggerErrorMock }),
}))

vi.mock('@crewmeld/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ config: { ragflowDatasetIds: ['dataset-1'] } }]),
        }),
      }),
    }),
  },
  digitalEmployees: { id: 'employee-id', config: 'employee-config' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
}))

import { GET } from './route'

describe('GET /api/employee/employees/[id]/chat-knowledge-bases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: null })
    listDatasetsMock.mockReset()
    loggerErrorMock.mockReset()
  })

  it('does not log secret-bearing errors from a rejected dataset request', async () => {
    const error = new Error('RAGFlow token: secret-ragflow-token')
    listDatasetsMock.mockRejectedValue(error)

    const response = await GET({} as never, {
      params: Promise.resolve({ id: 'employee-1' }),
    })
    const body = await response.text()

    expect(response.status).toBe(502)
    expect(body).not.toContain('secret-ragflow-token')
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to load employee chat knowledge bases', {
      errorType: 'Error',
    })
    expect(loggerErrorMock.mock.calls[0][1]).not.toBe(error)
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-ragflow-token')
  })
})
