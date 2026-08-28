import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }))
const authenticateEmployeeApiKeyMock = vi.fn()
const listTopFrequentQuestionsMock = vi.fn()
const lookup = {
  results: [] as Array<Array<Record<string, unknown>>>,
  errorAt: undefined as number | undefined,
  calls: [] as Array<{ condition: unknown }>,
}

vi.mock('@/lib/employee-api/auth', () => ({
  authenticateEmployeeApiKey: (...args: unknown[]) => authenticateEmployeeApiKeyMock(...args),
}))

vi.mock('@/lib/knowledge/analytics/repository', () => ({
  listTopFrequentQuestions: (...args: unknown[]) => listTopFrequentQuestionsMock(...args),
}))

vi.mock('@/lib/knowledge/qa/repository', () => ({
  qaQuestionRepository: { list: vi.fn().mockResolvedValue({ rows: [] }) },
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
    knowledgeBases: { id: 'knowledge-base-id', ragflowDatasetId: 'ragflow-dataset-id', enabled: 'enabled' },
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
  return new Request(`http://localhost/questions/top${query}`, {
    headers: { authorization: 'Bearer test-key' },
  })
}

function context(employeeId = 'employee-1', datasetId = 'dataset-1') {
  return { params: Promise.resolve({ employeeId, datasetId }) }
}

describe('GET /api/public/employees/[employeeId]/knowledge-bases/[datasetId]/questions/top', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetDbMock()
    authenticateEmployeeApiKeyMock.mockResolvedValue({ ok: true, principal: {} })
    listTopFrequentQuestionsMock.mockReset()
    loggerErrorMock.mockReset()
    lookup.results = [
      [{ config: { ragflowDatasetIds: ['dataset-1'] } }],
      [{ id: 'local-kb-id' }],
    ]
    lookup.errorAt = undefined
    lookup.calls = []
  })

  it('returns 401 for an invalid API key', async () => {
    authenticateEmployeeApiKeyMock.mockResolvedValue({ ok: false, reason: 'invalid_api_key' })

    const response = await GET(request(), context())

    expect(response.status).toBe(401)
    expect(lookup.calls).toHaveLength(0)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 403 when the request origin is denied', async () => {
    authenticateEmployeeApiKeyMock.mockResolvedValue({ ok: false, reason: 'origin_denied' })

    const response = await GET(request(), context())

    expect(response.status).toBe(403)
    expect(lookup.calls).toHaveLength(0)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('logs a safe error and returns a generic response when authentication rejects', async () => {
    const error = new Error('auth database credential: secret-auth-token')
    authenticateEmployeeApiKeyMock.mockRejectedValue(error)

    const response = await GET(request(), context())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-auth-token')
    expect(lookup.calls).toHaveLength(0)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock.mock.calls[0]).toEqual([
      'Failed to fetch top frequent questions',
      { errorType: 'Error' },
    ])
    expect(loggerErrorMock.mock.calls[0][1]).not.toBe(error)
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-auth-token')
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

  it('maps a bound dataset to its enabled local knowledge base and preserves pending questions', async () => {
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
    expect((await response.json())).toMatchObject({
      data: [{ id: 'question-1', occurrenceCount: 3, status: 'pending' }],
      topN: 3,
      datasetId: 'dataset-1',
    })
  })

  it('requires the dataset lookup to be enabled without restricting its knowledge-base type', async () => {
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

  it('logs a safe error and returns a generic response when a lookup fails', async () => {
    lookup.errorAt = 1

    const response = await GET(request(), context())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-db-password')
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to fetch top frequent questions', {
      errorType: 'Error',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-db-password')
  })

  it('logs a safe error and returns a generic response when the analytics query fails', async () => {
    listTopFrequentQuestionsMock.mockRejectedValue(new Error('analytics token: secret-analytics-token'))

    const response = await GET(request(), context())
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-analytics-token')
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to fetch top frequent questions', {
      errorType: 'Error',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret-analytics-token')
  })
})
