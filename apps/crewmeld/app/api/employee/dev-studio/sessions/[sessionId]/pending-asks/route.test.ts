/**
 * @vitest-environment node
 *
 * Tests for GET /sessions/:sessionId/pending-asks — re-surfaces a session's
 * still-pending HITL asks so the workbench can rebuild answerable inline cards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: { get: (...args: unknown[]) => storeGet(...args) },
}))

// db.select().from().where().orderBy() resolves to whatever `selectRows` holds.
let selectRows: unknown[] = []
vi.mock('@crewmeld/db', () => {
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => Promise.resolve(selectRows)),
    }
    return builder
  })
  return {
    db: { select },
    toolDevPendingActions: {
      __table: 'tool_dev_pending_actions',
      sessionId: 'session_id',
      askId: 'ask_id',
      type: 'type',
      payload: 'payload',
      status: 'status',
      createdAt: 'created_at',
    },
  }
})

const ctx = { params: Promise.resolve({ sessionId: 's1' }) }
function req() {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/pending-asks')
}
function authed() {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
}

describe('GET /sessions/:sessionId/pending-asks', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    selectRows = []
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 when the session is missing or owned by another user', async () => {
    authed()
    storeGet.mockResolvedValueOnce(null)
    const { GET } = await import('./route')
    let res = await GET(req(), ctx)
    expect(res.status).toBe(404)

    storeGet.mockResolvedValueOnce({ id: 's1', userId: 'other' })
    res = await GET(req(), ctx)
    expect(res.status).toBe(404)
  })

  it('reconstructs pending asks, with askId/type authoritative from the row', async () => {
    authed()
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1' })
    selectRows = [
      {
        askId: 'a1',
        type: 'choice',
        // payload is the stored full Ask; askId/type here are intentionally
        // stale to prove the row columns win.
        payload: {
          askId: 'STALE',
          type: 'STALE',
          question: 'Pick one',
          options: [{ value: 'x', label: 'X' }],
        },
      },
      {
        askId: 'a2',
        type: 'text',
        payload: { prompt: 'Describe it', placeholder: 'hint' },
      },
    ]
    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { asks: Array<Record<string, unknown>> }
    expect(body.asks).toHaveLength(2)
    expect(body.asks[0]).toMatchObject({ askId: 'a1', type: 'choice', question: 'Pick one' })
    expect(body.asks[1]).toMatchObject({ askId: 'a2', type: 'text', prompt: 'Describe it' })
  })

  it('returns an empty list when nothing is pending', async () => {
    authed()
    storeGet.mockResolvedValue({ id: 's1', userId: 'user-1' })
    selectRows = []
    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { asks: unknown[] }
    expect(body.asks).toEqual([])
  })
})
