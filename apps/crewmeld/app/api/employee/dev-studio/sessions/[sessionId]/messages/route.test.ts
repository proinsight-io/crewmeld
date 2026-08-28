/**
 * @vitest-environment node
 *
 * GET /api/employee/dev-studio/sessions/:sessionId/messages
 *
 * Verified behaviors:
 *  - 401 unauthenticated
 *  - 404 session not found
 *  - 404 session belongs to another user
 *  - claudecode session reads tool_dev_messages, returns { messages: rows[] }
 *  - opencode, no container, opencodeSessionId set: reads opencode.db from disk
 *  - opencode, no container, null opencodeSessionId: discovers session id, then reads disk
 *  - opencode, no container, null opencodeSessionId + discover null: returns empty messages
 *  - opencode, live container, opencodeSessionId null: empty messages (no sandbox call)
 *  - opencode, live container, getEndpoint throws: 502
 *  - opencode, live container, opencodeSessionId set: calls listOpencodeMessages, maps messages
 *  - toUiMessages skips items where info.id or info.role is missing/invalid
 *  - toUiMessages skips parts that are missing id or type
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── env mock ─────────────────────────────────────────────────────────────────
vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    OPENSANDBOX_USE_PROXY: false,
    OPENCODE_SERVER_PASSWORD: 'pw',
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_PORT: 4096,
  }),
}))

// ── coder-providers mock ──────────────────────────────────────────────────────
vi.mock('@/lib/dev-studio/coder-providers', () => ({
  getCoderProvider: (_type: string) => ({
    id: 'opencode',
    port: 4096,
    authHeader: (_env: unknown) => ({ Authorization: 'Basic dGVzdA==' }),
  }),
}))

// ── opensandbox client mock ───────────────────────────────────────────────────
const getEndpoint = vi.fn()
const proxyHeaders = vi.fn().mockReturnValue({})
const isSandboxRunning = vi.fn()
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    getEndpoint = getEndpoint
    proxyHeaders = proxyHeaders
    isSandboxRunning = isSandboxRunning
  },
}))

// ── opencode-rest mock ────────────────────────────────────────────────────────
const listOpencodeMessagesMock = vi.fn()
vi.mock('@/lib/dev-studio/opencode-rest', () => ({
  listOpencodeMessages: (...args: unknown[]) => listOpencodeMessagesMock(...args),
}))

// ── opencode-db mock (disk-read branch) ──────────────────────────────────────
const readDisk = vi.fn()
const discover = vi.fn()
vi.mock('@/lib/dev-studio/opencode-db', () => ({
  readOpencodeHistoryFromDisk: (...args: unknown[]) => readDisk(...args),
  discoverOpencodeSessionId: (...args: unknown[]) => discover(...args),
}))

// ── paths mock ────────────────────────────────────────────────────────────────
vi.mock('@/lib/dev-studio/paths', () => ({
  paths: {
    sessionOpencodeData: {
      forBff: (id: string) => `/vol/sessions/${id}/opencode`,
    },
  },
}))

// ── auth mock ─────────────────────────────────────────────────────────────────
const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

// ── session store mock ────────────────────────────────────────────────────────
const storeGet = vi.fn()
const storeUpdate = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
  },
}))

// ── db mock (claudecode branch) ───────────────────────────────────────────────
let dbSelectResult: unknown[] = []
vi.mock('@crewmeld/db', () => {
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => Promise.resolve(dbSelectResult)),
    }
    return builder
  })
  return {
    db: { select },
    toolDevMessages: {
      __table: 'tool_dev_messages',
      sessionId: 'session_id',
      sequence: 'sequence',
    },
  }
})

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  asc: vi.fn((col: unknown) => col),
  eq: vi.fn((_col: unknown, _val: unknown) => 'eq'),
}))

// ─────────────────────────────────────────────────────────────────────────────

import { GET } from './route'

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_ID = 'user-msg'

function makeReq(): Request {
  return new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/messages`)
}

function ctx(sessionId: string = SESSION_ID) {
  return { params: Promise.resolve({ sessionId }) }
}

function claudecodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    coderType: 'claudecode' as const,
    activeContainerId: 'sbx-1',
    opencodeSessionId: null as string | null,
    ...overrides,
  }
}

function opencodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    coderType: 'opencode' as const,
    activeContainerId: 'sbx-1',
    opencodeSessionId: 'oc_ses_1' as string | null,
    ...overrides,
  }
}

describe('GET /sessions/:id/messages', () => {
  beforeEach(() => {
    storeGet.mockReset()
    storeUpdate.mockReset()
    storeUpdate.mockResolvedValue(undefined)
    getEndpoint.mockReset()
    isSandboxRunning.mockReset()
    proxyHeaders.mockReset()
    proxyHeaders.mockReturnValue({})
    listOpencodeMessagesMock.mockReset()
    readDisk.mockReset()
    discover.mockReset()
    mockGetCurrentUserRole.mockReset()
    dbSelectResult = []
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: USER_ID,
      role: 'member',
      error: null,
    })
  })

  // ── auth / lookup guards ───────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValueOnce({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(401)
  })

  it('returns 404 when session not found', async () => {
    storeGet.mockResolvedValueOnce(null)
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to another user', async () => {
    storeGet.mockResolvedValueOnce(claudecodeSession({ userId: 'other' }))
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(404)
  })

  // ── claudecode branch ──────────────────────────────────────────────────────

  it('claudecode: reads tool_dev_messages and returns { messages: rows[] }', async () => {
    storeGet.mockResolvedValueOnce(claudecodeSession())
    dbSelectResult = [
      { id: 1, sessionId: SESSION_ID, sequence: 1, kind: 'user', payload: { type: 'user' } },
      {
        id: 2,
        sessionId: SESSION_ID,
        sequence: 2,
        kind: 'assistant_text',
        payload: { type: 'assistant' },
      },
    ]
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: unknown[] }
    expect(body.messages).toHaveLength(2)
    expect(listOpencodeMessagesMock).not.toHaveBeenCalled()
    expect(readDisk).not.toHaveBeenCalled()
  })

  // ── opencode, no live container (disk-read) ────────────────────────────────

  it('opencode: reads opencode.db from disk when there is no live container', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ activeContainerId: null }))
    readDisk.mockReturnValue([
      { info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', type: 'text' }] },
    ])
    const res = await GET(makeReq(), ctx())
    const body = (await res.json()) as { messages: unknown[]; opencodeSessionId: string | null }
    expect(res.status).toBe(200)
    expect(readDisk).toHaveBeenCalledWith(
      `/vol/sessions/${SESSION_ID}/opencode/opencode.db`,
      'oc_ses_1'
    )
    expect(listOpencodeMessagesMock).not.toHaveBeenCalled()
    expect(body.messages).toHaveLength(1)
    expect(body.opencodeSessionId).toBe('oc_ses_1')
  })

  it('opencode: discovers session id when row lacks one and reads disk', async () => {
    storeGet.mockResolvedValueOnce(
      opencodeSession({ activeContainerId: null, opencodeSessionId: null })
    )
    discover.mockReturnValue('ses_found')
    readDisk.mockReturnValue([])
    const res = await GET(makeReq(), ctx())
    const body = (await res.json()) as { opencodeSessionId: string | null }
    expect(discover).toHaveBeenCalledWith(`/vol/sessions/${SESSION_ID}/opencode/opencode.db`)
    expect(readDisk).toHaveBeenCalledWith(
      `/vol/sessions/${SESSION_ID}/opencode/opencode.db`,
      'ses_found'
    )
    expect(body.opencodeSessionId).toBe('ses_found')
  })

  it('opencode: returns empty messages when no container and discover returns null', async () => {
    storeGet.mockResolvedValueOnce(
      opencodeSession({ activeContainerId: null, opencodeSessionId: null })
    )
    discover.mockReturnValue(null)
    const res = await GET(makeReq(), ctx())
    const body = (await res.json()) as { messages: unknown[]; opencodeSessionId: unknown }
    expect(res.status).toBe(200)
    expect(body.messages).toEqual([])
    expect(body.opencodeSessionId).toBeNull()
    expect(readDisk).not.toHaveBeenCalled()
  })

  // ── opencode, live container path ──────────────────────────────────────────

  it('opencode: returns empty messages when container is live but opencodeSessionId is null', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: null }))
    const res = await GET(makeReq(), ctx())
    const body = (await res.json()) as { messages: unknown[]; opencodeSessionId: unknown }
    expect(res.status).toBe(200)
    expect(body.messages).toEqual([])
    expect(body.opencodeSessionId).toBeNull()
    expect(listOpencodeMessagesMock).not.toHaveBeenCalled()
    expect(getEndpoint).not.toHaveBeenCalled()
  })

  it('opencode: returns 502 when getEndpoint throws (container present)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    getEndpoint.mockRejectedValueOnce(new Error('unreachable'))
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(502)
    expect(listOpencodeMessagesMock).not.toHaveBeenCalled()
  })

  it('opencode + opencodeSessionId set: calls listOpencodeMessages and returns mapped messages', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: 'oc_ses_1' }))
    getEndpoint.mockResolvedValueOnce('http://h:4096')
    listOpencodeMessagesMock.mockResolvedValueOnce([
      {
        info: { id: 'msg_1', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
        parts: [{ id: 'pt_1', type: 'text', text: 'hello' }],
      },
      {
        info: { id: 'msg_2', role: 'assistant', createdAt: '2026-01-01T00:00:01Z' },
        parts: [
          { id: 'pt_2', type: 'text', text: 'world' },
          { id: 'pt_3', type: 'tool-invocation', tool: 'bash', state: 'result' },
        ],
      },
    ])
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    expect(listOpencodeMessagesMock).toHaveBeenCalledWith(
      'http://h:4096',
      expect.objectContaining({ Authorization: expect.any(String) }),
      'oc_ses_1'
    )
    const body = (await res.json()) as {
      messages: Array<{ id: string; role: string; parts: unknown[] }>
      opencodeSessionId: string | null
    }
    expect(body.opencodeSessionId).toBe('oc_ses_1')
    expect(body.messages).toHaveLength(2)
    const [first, second] = body.messages
    expect(first?.id).toBe('msg_1')
    expect(first?.role).toBe('user')
    expect(first?.parts).toHaveLength(1)
    expect((first?.parts[0] as Record<string, unknown>)?.['text']).toBe('hello')
    expect(second?.id).toBe('msg_2')
    expect(second?.role).toBe('assistant')
    expect(second?.parts).toHaveLength(2)
    expect((second?.parts[1] as Record<string, unknown>)?.['tool']).toBe('bash')
  })

  it('opencode: on upstream 404 with a dead sandbox, demotes the row and serves disk history', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: 'oc_ses_1' }))
    getEndpoint.mockResolvedValueOnce('http://h:4096')
    listOpencodeMessagesMock.mockRejectedValueOnce(
      new Error('opencode list messages failed: 404')
    )
    // The proxy 404'd because the sandbox is gone — confirm via lifecycle API.
    isSandboxRunning.mockResolvedValueOnce(false)
    readDisk.mockReturnValueOnce([
      { info: { id: 'msg_disk', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: 'hi' }] },
    ])

    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    expect(isSandboxRunning).toHaveBeenCalledWith('sbx-1')
    expect(storeUpdate).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ containerStatus: 'destroyed', activeContainerId: null })
    )
    const body = (await res.json()) as {
      messages: Array<{ id: string }>
      opencodeSessionId: string | null
    }
    expect(body.opencodeSessionId).toBe('oc_ses_1')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.id).toBe('msg_disk')
  })

  it('opencode: rethrows a non-404 REST error (does not demote)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: 'oc_ses_1' }))
    getEndpoint.mockResolvedValueOnce('http://h:4096')
    listOpencodeMessagesMock.mockRejectedValueOnce(
      new Error('opencode list messages failed: 500')
    )
    await expect(GET(makeReq(), ctx())).rejects.toThrow(/failed: 500/)
    expect(storeUpdate).not.toHaveBeenCalled()
  })

  // ── toUiMessages parse-guards (exercised through live-container REST branch) ─

  it('opencode: skips items where info.id or info.role is missing/invalid', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: 'oc_ses_1' }))
    getEndpoint.mockResolvedValueOnce('http://h:4096')
    listOpencodeMessagesMock.mockResolvedValueOnce([
      { info: { id: 'msg_ok', role: 'user' }, parts: [] },
      { info: { id: 'msg_bad_role', role: 'unknown' }, parts: [] },
      { info: null, parts: [] },
      { info: { role: 'assistant' }, parts: [] },
    ])
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: unknown[] }
    expect(body.messages).toHaveLength(1)
    expect((body.messages[0] as Record<string, unknown>)?.['id']).toBe('msg_ok')
  })

  it('opencode: skips parts that are missing id or type', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: 'oc_ses_1' }))
    getEndpoint.mockResolvedValueOnce('http://h:4096')
    listOpencodeMessagesMock.mockResolvedValueOnce([
      {
        info: { id: 'msg_1', role: 'user' },
        parts: [
          { id: 'pt_ok', type: 'text', text: 'hi' },
          { type: 'text' },
          { id: 'pt_no_type' },
          null,
          'not-an-object',
        ],
      },
    ])
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: Array<{ parts: unknown[] }> }
    expect(body.messages[0]?.parts).toHaveLength(1)
  })
})
