import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }))
const requirePermissionMock = vi.fn()
const listTopFrequentQuestionsMock = vi.fn()
const knowledgeBaseLookup = {
  error: undefined as unknown,
  rows: [] as Array<{ id: string }>,
  whereConditions: [] as unknown[],
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

vi.mock('@crewmeld/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          knowledgeBaseLookup.whereConditions.push(condition)
          return {
            limit: () =>
              knowledgeBaseLookup.error
                ? Promise.reject(knowledgeBaseLookup.error)
                : Promise.resolve(knowledgeBaseLookup.rows),
          }
        },
      }),
    }),
  },
  knowledgeBases: { id: 'id', enabled: 'enabled' },
}))

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ operator: 'and', conditions }),
  eq: (field: unknown, value: unknown) => ({ operator: 'eq', field, value }),
}))

import { GET } from './route'
import { QA_PERMISSIONS } from '@/lib/knowledge/qa/permissions'

function request(query = '') {
  return { nextUrl: new URL(`http://localhost/questions/top${query}`) } as never
}

function context(knowledgeBaseId: string) {
  return { params: Promise.resolve({ knowledgeBaseId }) }
}

describe('GET /api/employee/knowledge/[knowledgeBaseId]/questions/top', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listTopFrequentQuestionsMock.mockReset()
    loggerErrorMock.mockReset()
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: null })
    knowledgeBaseLookup.error = undefined
    knowledgeBaseLookup.rows = [{ id: 'kb1' }]
    knowledgeBaseLookup.whereConditions = []
  })

  it('returns historical top questions including pending entries', async () => {
    listTopFrequentQuestionsMock.mockResolvedValue([
      {
        id: 'q1',
        knowledgeBaseId: 'kb1',
        question: '电池离线怎么办？',
        occurrenceCount: 3,
        lastSeenAt: new Date('2026-08-03'),
        status: 'pending',
      },
    ])

    const response = await GET(request('?topN=3'), context('kb1'))

    expect(response.status).toBe(200)
    expect(listTopFrequentQuestionsMock).toHaveBeenCalledWith('kb1', 3)
    expect((await response.json()).data[0]).toMatchObject({
      id: 'q1',
      occurrenceCount: 3,
      status: 'pending',
    })
  })

  it('returns the authorization response when the caller is unauthenticated', async () => {
    requirePermissionMock.mockResolvedValue({ authenticated: false, error: 'UNAUTHENTICATED' })

    const response = await GET(request(), context('kb1'))

    expect(response.status).toBe(401)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 403 when the authenticated caller lacks knowledge-list permission', async () => {
    requirePermissionMock.mockResolvedValue({ authenticated: true, error: 'api.common.forbidden' })

    const response = await GET(request(), context('kb1'))

    expect(response.status).toBe(403)
    expect(requirePermissionMock).toHaveBeenCalledWith(QA_PERMISSIONS.view)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the local knowledge base is missing or disabled', async () => {
    knowledgeBaseLookup.rows = []

    const response = await GET(request(), context('kb1'))

    expect(response.status).toBe(404)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })

  it('looks up the requested knowledge base with enabled=true', async () => {
    listTopFrequentQuestionsMock.mockResolvedValue([])

    await GET(request(), context('kb1'))

    expect(knowledgeBaseLookup.whereConditions).toEqual([
      {
        operator: 'and',
        conditions: [
          { operator: 'eq', field: 'id', value: 'kb1' },
          { operator: 'eq', field: 'enabled', value: true },
        ],
      },
    ])
  })

  it('logs and safely hides a knowledge-base lookup failure', async () => {
    const error = new Error('database password: secret-db-password')
    knowledgeBaseLookup.error = error

    const response = await GET(request(), context('kb1'))
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-db-password')
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock.mock.calls[0]).toEqual([
      'Failed to fetch top frequent questions',
      { errorType: 'Error' },
    ])
    expect(loggerErrorMock.mock.calls[0][1]).not.toBe(error)
    expect(JSON.stringify(loggerErrorMock.mock.calls[0])).not.toContain('secret-db-password')
  })

  it('logs and safely hides a historical-query failure', async () => {
    const error = new Error('analytics token: secret-analytics-token')
    listTopFrequentQuestionsMock.mockRejectedValue(error)

    const response = await GET(request(), context('kb1'))
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('api.common.internalError')
    expect(body).not.toContain('secret-analytics-token')
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock.mock.calls[0]).toEqual([
      'Failed to fetch top frequent questions',
      { errorType: 'Error' },
    ])
    expect(loggerErrorMock.mock.calls[0][1]).not.toBe(error)
    expect(JSON.stringify(loggerErrorMock.mock.calls[0])).not.toContain('secret-analytics-token')
  })

  it.each(['0', '101', 'abc'])('rejects invalid topN=%s', async (topN) => {
    const response = await GET(request(`?topN=${topN}`), context('kb1'))

    expect(response.status).toBe(400)
    expect(listTopFrequentQuestionsMock).not.toHaveBeenCalled()
  })
})
