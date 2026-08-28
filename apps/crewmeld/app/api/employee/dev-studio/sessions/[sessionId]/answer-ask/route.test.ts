/**
 * @vitest-environment node
 *
 * Tests for POST /api/employee/dev-studio/sessions/:sessionId/answer-ask.
 *
 * The route flips the matching `tool_dev_pending_actions` row from `pending`
 * to `answered` with the user's answer JSON, then queues a synthetic
 * `<answer id="..."></answer>` system note so the AI sees the response on
 * its next chat turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const queueSystemNote = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    queueSystemNote: (...args: unknown[]) => queueSystemNote(...args),
  },
}))

/**
 * Capture the `update(...).set(...).where(...)` chain. We don't assert on
 * the where-clause structure (drizzle internals), but we do assert on the
 * `set` payload and the table the update targeted.
 */
const setCalls: unknown[] = []
const whereCalls: unknown[] = []
const updateMock = vi.fn((table: unknown) => {
  void table
  const chain = {
    set(values: unknown) {
      setCalls.push(values)
      return {
        where(cond: unknown) {
          whereCalls.push(cond)
          return Promise.resolve(undefined)
        },
      }
    },
  }
  return chain
})

vi.mock('@crewmeld/db', () => ({
  db: { update: updateMock },
  toolDevPendingActions: {
    __table: 'tool_dev_pending_actions',
    sessionId: 'session_id',
    askId: 'ask_id',
  },
}))

function authedOwner() {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
  storeGet.mockResolvedValue({ id: 's1', userId: 'user-1', status: 'active' })
}

function answerReq(body: unknown): Request {
  return new Request('http://test/api/employee/dev-studio/sessions/s1/answer-ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions/:sessionId/answer-ask', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    queueSystemNote.mockReset()
    updateMock.mockClear()
    setCalls.length = 0
    whereCalls.length = 0
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(answerReq({ askId: 'q1', answer: 'a' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(401)
    expect(updateMock).not.toHaveBeenCalled()
    expect(queueSystemNote).not.toHaveBeenCalled()
  })

  it('returns 404 when session does not exist', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(answerReq({ askId: 'q1', answer: 'a' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 cross-user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      role: 'member',
      error: null,
    })
    storeGet.mockResolvedValue({ id: 's1', userId: 'other', status: 'active' })
    const { POST } = await import('./route')
    const res = await POST(answerReq({ askId: 'q1', answer: 'a' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when askId missing', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(answerReq({ answer: 'a' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('updates the row to answered and queues the answer note (bare value)', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(answerReq({ askId: 'q1', answer: 'yes' }), {
      params: Promise.resolve({ sessionId: 's1' }),
    })
    expect(res.status).toBe(204)
    expect(updateMock).toHaveBeenCalledTimes(1)
    const set = setCalls[0] as { status: string; answer: unknown; answeredAt: Date }
    expect(set.status).toBe('answered')
    expect(set.answer).toBe('yes')
    expect(set.answeredAt).toBeInstanceOf(Date)
    expect(queueSystemNote).toHaveBeenCalledWith(
      's1',
      '<answer id="q1">"yes"</answer>'
    )
  })

  it('unwraps {value} envelope when present', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(
      answerReq({ askId: 'q2', answer: { value: 'option-a' } }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
    expect(queueSystemNote).toHaveBeenCalledWith(
      's1',
      '<answer id="q2">"option-a"</answer>'
    )
  })

  it('serializes non-string answers as JSON inside the note', async () => {
    authedOwner()
    const { POST } = await import('./route')
    const res = await POST(
      answerReq({ askId: 'q3', answer: { value: { nested: true, n: 42 } } }),
      { params: Promise.resolve({ sessionId: 's1' }) }
    )
    expect(res.status).toBe(204)
    expect(queueSystemNote).toHaveBeenCalledWith(
      's1',
      '<answer id="q3">{"nested":true,"n":42}</answer>'
    )
  })
})
