/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requirePermission, select, rows } = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  select: vi.fn(),
  rows: [] as unknown[][],
}))

vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))

vi.mock('@crewmeld/db', () => {
  const chain = {
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows.shift() ?? []),
  }
  select.mockImplementation(() => ({ from: vi.fn(() => chain) }))
  return { db: { select }, toolInstances: {}, tools: {} }
})

import { GET } from './route'

const context = { params: Promise.resolve({ id: 'instance-1' }) }
const request = new Request('http://test/api/employee/skills/instances/instance-1/openapi')

beforeEach(() => {
  vi.clearAllMocks()
  rows.length = 0
  requirePermission.mockResolvedValue({ authenticated: true, userId: 'user-1', error: null })
})

describe('GET instance OpenAPI document', () => {
  it('does not expose service schemas without skill:list permission', async () => {
    requirePermission.mockResolvedValue({
      authenticated: false,
      error: 'api.common.unauthorized',
    })

    const response = await GET(request, context)

    expect(response.status).toBe(401)
    expect(select).not.toHaveBeenCalled()
  })

  it('rejects HTTP services instead of documenting an unusable JSON invoke endpoint', async () => {
    rows.push([
      {
        id: 'instance-1',
        publishedAsService: true,
        serviceAuthMode: 'anonymous',
        name: 'Website',
        description: null,
        apiSpec: null,
        serviceSpec: { type: 'http', port: 9876, path: '/', method: 'GET' },
      },
    ])

    const response = await GET(request, context)

    expect(response.status).toBe(409)
  })

  it('documents the invoke endpoint for JSON services', async () => {
    rows.push([
      {
        id: 'instance-1',
        publishedAsService: true,
        serviceAuthMode: 'anonymous',
        name: 'Weather',
        description: null,
        apiSpec: { type: 'object', properties: { city: { type: 'string' } } },
        serviceSpec: { type: 'json', port: 9876, path: '/weather', method: 'POST' },
      },
    ])

    const response = await GET(request, context)
    const body = (await response.json()) as { paths: Record<string, unknown> }

    expect(response.status).toBe(200)
    expect(Object.keys(body.paths)).toEqual(['/api/tools/instance-1/invoke'])
  })
})
