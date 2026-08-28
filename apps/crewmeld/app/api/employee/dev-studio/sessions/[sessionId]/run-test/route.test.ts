/**
 * @vitest-environment node
 *
 * Tests for POST /api/employee/dev-studio/sessions/:sessionId/run-test (SSE).
 *
 * Boundaries mocked: auth + sessionStore + redis lock + sandbox-loader.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
  },
}))

const mockAcquireLock = vi.fn()
const mockReleaseLock = vi.fn()
vi.mock('@/lib/core/config/redis', () => ({
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
}))

const mockRunFreshTest = vi.fn()
vi.mock('@/lib/dev-studio/sandbox-loader', () => ({
  runFreshTest: (...args: unknown[]) => mockRunFreshTest(...args),
}))

const mockDbInsert = vi.fn()
vi.mock('@crewmeld/db', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
  toolExecutions: { __table: 'tool_executions' },
}))

function makeReq(body: unknown): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/run-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const CTX = { params: Promise.resolve({ sessionId: 's1' }) }

function authedOwner(): void {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
  storeGet.mockResolvedValue({
    id: 's1',
    userId: 'user-1',
    status: 'active',
    workspaceDir: '/ws/s1',
  })
}

/** Read all SSE frames from a streaming response. */
async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text()
  const frames: Array<{ event: string; data: unknown }> = []
  const rawFrames = text.split('\n\n').filter((f) => f.trim().length > 0)
  for (const frame of rawFrames) {
    const eventMatch = frame.match(/^event:\s*(.+)$/m)
    const dataMatch = frame.match(/^data:\s*(.+)$/m)
    if (eventMatch && dataMatch) {
      frames.push({
        event: eventMatch[1],
        data: JSON.parse(dataMatch[1]),
      })
    }
  }
  return frames
}

describe('POST /api/employee/dev-studio/sessions/:sessionId/run-test (SSE)', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    mockAcquireLock.mockReset()
    mockReleaseLock.mockReset()
    mockRunFreshTest.mockReset()
    mockDbInsert.mockReset()
    // Default: drizzle insert chain `db.insert(table).values(row)` resolves.
    mockDbInsert.mockImplementation(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    }))
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: {}, env: {} }),
      CTX
    )
    expect(res.status).toBe(401)
    expect(mockRunFreshTest).not.toHaveBeenCalled()
  })

  it('returns 404 when session not found', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: {}, env: {} }),
      CTX
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when concurrent execution lock fails', async () => {
    authedOwner()
    mockAcquireLock.mockResolvedValue(false)
    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: {}, env: {} }),
      CTX
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('concurrent-execution')
    expect(mockRunFreshTest).not.toHaveBeenCalled()
  })

  it('returns 200 SSE stream with phase/result/done events', async () => {
    authedOwner()
    mockAcquireLock.mockResolvedValue(true)
    mockReleaseLock.mockResolvedValue(true)

    mockRunFreshTest.mockImplementation(
      (args: { emit: (event: Record<string, unknown>) => void }) => {
        args.emit({ type: 'phase', step: 'sync', status: 'start' })
        args.emit({ type: 'phase', step: 'sync', status: 'done', durationMs: 50, sizeBytes: 200 })
        args.emit({ type: 'result', success: true, data: { answer: 42 } })
        args.emit({ type: 'done', executionId: 'test-exec', sandboxId: 'sbx-1', kept: false })
        return Promise.resolve()
      }
    )

    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: { q: 'hello' }, env: { API_KEY: 'test' } }),
      CTX
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const frames = await readSSE(res)
    // First frame is now the synthetic `start` event broadcasting executionId
    // (added in Task 22 so the client can call /tool-execution/[execId]/files/*
    // before any phase resolves).
    expect(frames.length).toBe(5)
    expect(frames[0].event).toBe('start')
    expect((frames[0].data as { executionId: string }).executionId).toMatch(/^test_\d{8}_/)
    expect(frames[1].event).toBe('phase')
    expect(frames[2].event).toBe('phase')
    expect(frames[3].event).toBe('result')
    expect(frames[4].event).toBe('done')

    expect(mockReleaseLock).toHaveBeenCalled()
    expect(mockRunFreshTest).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', userId: 'user-1' })
    )
    // tool_executions row persisted before the stream started
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when tool_executions insert fails', async () => {
    authedOwner()
    mockAcquireLock.mockResolvedValue(true)
    mockReleaseLock.mockResolvedValue(true)
    mockDbInsert.mockImplementation(() => ({
      values: vi.fn().mockRejectedValue(new Error('db down')),
    }))

    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: { q: 'hello' }, env: {} }),
      CTX
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('execution-record-failed')
    expect(mockRunFreshTest).not.toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalled()
  })

  it('returns 400 when body fails validation', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ wrong: 'field' }),
      CTX
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('bad-request')
  })
})
