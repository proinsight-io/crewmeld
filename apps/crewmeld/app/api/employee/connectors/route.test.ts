/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/connectors (filter extensions).
 *
 * Focus: ?subtype= and ?withConfig=true query params added in Task 17.
 * Boundaries mocked: auth + db + encryption + connection-resolver.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequirePermission = vi.fn()
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}))

const mockSelect = vi.fn()
const mockFrom = vi.fn()
const mockWhere = vi.fn()
const mockOrderBy = vi.fn()
vi.mock('@crewmeld/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: vi.fn(),
  },
}))

vi.mock('@crewmeld/db/schema', () => ({
  CONNECTION_TYPES: ['database', 'api', 'mq'],
  systemConnections: {
    id: 'id',
    type: 'type',
    status: 'status',
    createdAt: 'createdAt',
  },
}))

const mockDecryptConfig = vi.fn()
vi.mock('@/lib/connectors/encryption', () => ({
  decryptConfig: (...args: unknown[]) => mockDecryptConfig(...args),
  encryptConfig: vi.fn(),
  maskSensitiveFields: (config: Record<string, unknown>) => {
    const out = { ...config }
    for (const k of Object.keys(out)) {
      if (/password|secret|apiKey/i.test(k)) out[k] = '***'
    }
    return out
  },
}))

vi.mock('@/lib/connectors/sanitize', () => ({
  sanitizeConnectionConfig: vi.fn(),
}))

vi.mock('@/lib/connectors/types', () => ({
  CHANNEL_TYPE_LIST: ['discord', 'telegram'],
}))

vi.mock('@/lib/dev-studio/connection-resolver', () => ({
  maskSensitive: (key: string, value: unknown) => {
    if (/password|token|secret|apikey|api_key/i.test(key) && value != null) return '***'
    return value
  },
}))

vi.mock('@/lib/api/response', () => ({
  apiOk: (data: unknown) => Response.json({ success: true, data }),
  apiErr: (msg: string, opts?: { status?: number }) =>
    new Response(JSON.stringify({ success: false, message: msg }), { status: opts?.status ?? 500 }),
  apiAuthErr: (auth: { error: string }) =>
    new Response(JSON.stringify({ success: false, message: auth.error }), { status: 401 }),
}))

vi.mock('@/lib/audit/with-audit', () => ({
  withAudit: (fn: unknown) => fn,
}))

vi.mock('@crewmeld/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

const SAMPLE_ROWS = [
  {
    id: 'conn-1',
    name: 'MySQL Prod',
    type: 'database',
    description: 'Production MySQL',
    status: 'connected',
    lastHealthCheck: new Date('2025-01-01'),
    lastHealthMessageI18n: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    configEncrypted: 'enc-1',
  },
  {
    id: 'conn-2',
    name: 'PG Staging',
    type: 'database',
    description: 'Staging Postgres',
    status: 'connected',
    lastHealthCheck: new Date('2025-01-01'),
    lastHealthMessageI18n: null,
    createdAt: new Date('2025-01-02'),
    updatedAt: new Date('2025-01-02'),
    configEncrypted: 'enc-2',
  },
]

function setupDbChain(rows: typeof SAMPLE_ROWS): void {
  mockOrderBy.mockResolvedValue(rows)
  mockWhere.mockReturnValue({ orderBy: mockOrderBy })
  mockFrom.mockReturnValue({ where: mockWhere })
  mockSelect.mockReturnValue({ from: mockFrom })
}

function setupAuth(): void {
  mockRequirePermission.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'admin',
    error: null,
  })
}

function makeReq(params: Record<string, string> = {}): Request {
  const url = new URL('http://test/api/employee/connectors')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return new Request(url.toString()) as unknown as Request
}

describe('GET /api/employee/connectors — filter extensions', () => {
  beforeEach(() => {
    mockRequirePermission.mockReset()
    mockSelect.mockReset()
    mockFrom.mockReset()
    mockWhere.mockReset()
    mockOrderBy.mockReset()
    mockDecryptConfig.mockReset()
  })

  it('filters by subtype (dbType in config)', async () => {
    setupAuth()
    setupDbChain(SAMPLE_ROWS)

    mockDecryptConfig.mockImplementation((enc: string) => {
      if (enc === 'enc-1') return JSON.stringify({ host: 'db1', password: 'pw', dbType: 'mysql' })
      if (enc === 'enc-2') return JSON.stringify({ host: 'db2', password: 'pw', dbType: 'postgresql' })
      return '{}'
    })

    const { GET } = await import('./route')
    const res = await GET(makeReq({ subtype: 'mysql' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { connections: Array<{ id: string }>; total: number }
    }
    expect(body.data.connections).toHaveLength(1)
    expect(body.data.connections[0].id).toBe('conn-1')
    expect(body.data.total).toBe(1)
  })

  it('includes configPreview when withConfig=true', async () => {
    setupAuth()
    setupDbChain([SAMPLE_ROWS[0]])

    mockDecryptConfig.mockReturnValue(
      JSON.stringify({ host: 'db1', password: 'secret123', apiKey: 'key-abc' })
    )

    const { GET } = await import('./route')
    const res = await GET(makeReq({ withConfig: 'true' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        connections: Array<{
          id: string
          configPreview: Record<string, unknown>
        }>
      }
    }
    const conn = body.data.connections[0]
    expect(conn.configPreview).toBeDefined()
    expect(conn.configPreview.host).toBe('db1')
    expect(conn.configPreview.password).toBe('***')
    expect(conn.configPreview.apiKey).toBe('***')
  })

  it('omits configPreview when withConfig is not set', async () => {
    setupAuth()
    setupDbChain([SAMPLE_ROWS[0]])

    mockDecryptConfig.mockReturnValue(JSON.stringify({ host: 'db1' }))

    const { GET } = await import('./route')
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { connections: Array<Record<string, unknown>> }
    }
    expect(body.data.connections[0].configPreview).toBeUndefined()
  })

  it('returns 401 when unauthenticated', async () => {
    mockRequirePermission.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })
})
