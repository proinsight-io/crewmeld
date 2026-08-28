import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }))
const requirePermissionMock = vi.fn()
const listTopFrequentQuestionsMock = vi.fn()
const lookup = {
  results: [] as Array<Array<Record<string, unknown>>>,
  errorAt: undefined as number | undefined,
  calls: [] as Array<{ condition: unknown }>,
}

vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}))

vi.mock('@/lib/knowledge/analytics/repository', () => ({
  listTopFrequentQuestions: (...args: unknown[]) => listTopFrequentQuestionsMock(...args),
}))

vi.mock('@crewmeld/logger', () => ({
  createLogger: () => ({ error: loggerErrorMock }),
}))

vi.mock('@crewmeld/db', () => {
  let selectCount = 0
  return {
    db: {
      select: () => {
        const index = selectCount++
        return {
          from: () => ({
            where: (condition: unknown) => {
              lookup.calls.push({ condition })
              return {
                limit: () =>
                  lookup.errorAt === index
                    ? Promise.reject(new Error('database password: secret-db-password'))
                    : Promise.resolve(lookup.results[index] ?? []),
              }
            },
          }),
        }
      },
    },
    digitalEmployees: { id: 'employee-id', config: 'employee-config' },
    knowledgeBases: {
      id: 'knowledge-base-id',
      ragflowDatasetId: 'ragflow-dataset-id',
      enabled: 'enabled',
      type: 'knowledge-base-type',
    },
    __resetDbMock: () => {
      selectCount = 0
    },
  }
})

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ operator: 'and', conditions }),
  eq: (field: unknown, value: unknown) => ({ operator: 'eq', field, value }),
}))

import { __resetDbMock } from '@crewmeld/db'
import { GET } from './route'

function request(query = '') {
  return { nextUrl: new URL(`http://localhost/questions/top${query}`) } as never
}

function context(id = 'employee-1', datasetId = 'dataset-1') {
  return { params: Promise.resolve({ id, datasetId }) }
}

describe('GET /api/employee/employees/[id]/chat-knowledge-bases/[datasetId]/questions/top', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetDbMock()
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: null })
    listTopFrequentQuestionsMock.mockReset()
    loggerErrorMock.mockReset()
    lookup.results = [
      [{ config: { ragflowDatasetIds: ['dataset-1'] } }],
      [{ id: 'local-kb-id', type: 'document' }],
    ]
    lookup.errorAt = undefined
    lookup.calls = []
  })

  it('requires employee-list permission', async () => {
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: 'api.common.forbidden' })

    const response = await GET(request(), context())

    expect(response.status).toBe(403)
    expect(requirePermissionMock).toHaveBeenCalledWith('employee:list')
    expect(lookup.calls).toHaveLength(0)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the employee does not exist', async () => {
    lookup.results[0] = []

    const response = await GET(request(), context())

    expect(response.status).toBe(404)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the dataset is not bound to the employee', async () => {
    lookup.results[0] = [{ config: { ragflowDatasetIds: ['another-dataset'] } }]

    const response = await GET(request(), context())

    expect(response.status).toBe(404)
    expect(lookup.calls).toHaveLength(1)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the bound dataset has no enabled local knowledge base', async () => {
    lookup.results[1] = []

    const response = await GET(request(), context())

    expect(response.status).toBe(404)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('maps a bound document dataset on the server and preserves pending questions', async () => {
    listTopFrequentQuestionsMock.mockResolvedValue([
      {
        id: 'question-1',
        knowledgeBaseId: 'local-kb-id',
        question: '电池离线怎么办？',
        occurrenceCount: 3,
        lastSeenAt: new Date('2026-08-03T00:00:00.000Z'),
        status: 'pending',
      },
    ])

    const response = await GET(request('?topN=3'), context())

    expect(response.status).toBe(200)
    expect(listTopFrequentQuestionsMock).toHaveBeenCalledWith('local-kb-id', 3)
    expect(await response.json()).toMatchObject({
      data: [{ id: 'question-1', occurrenceCount: 3, status: 'pending' }],
      topN: 3,
      datasetId: 'dataset-1',
    })
  })

  it('requires the server-side dataset mapping to be enabled without restricting document type', async () => {
    listTopFrequentQuestionsMock.mockResolvedValue([])

    await GET(request(), context())

    expect(lookup.calls[1]).toEqual({
      condition: {
        operator: 'and',
        conditions: [
          { operator: 'eq', field: 'ragflow-dataset-id', value: 'dataset-1' },
          { operator: 'eq', field: 'enabled', value: true },
        ],
      },
    })
  })

  it.each(['0', '101', 'abc'])('returns 400 for invalid topN=%s', async (topN) => {
    const response = await GET(request(`?topN=${topN}`), context())

    expect(response.status).toBe(400)
    expect(lookup.calls).toHaveLength(0)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('logs a safe error and returns a generic response when a lookup rejects', async () => {
    lookup.errorAt = 1

    const response = await GET(request(), context())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-db-password')
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to fetch chat top questions', {
      errorType: 'Error',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-db-password')
  })

  it('logs a safe error when the historical query rejects with a secret', async () => {
    listTopFrequentQuestionsMock.mockRejectedValue(
      new Error('analytics token: secret-analytics-token')
    )

    const response = await GET(request(), context())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-analytics-token')
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to fetch chat top questions', {
      errorType: 'Error',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-analytics-token')
  })
})
