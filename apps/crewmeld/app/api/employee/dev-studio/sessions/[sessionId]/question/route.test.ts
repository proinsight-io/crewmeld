/**
 * @vitest-environment node
 *
 * BFF question route — relays question replies/rejections to opencode.
 * Only valid for opencode sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'i',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    OPENCODE_SERVER_PASSWORD: 'pw',
    OPENCODE_SERVER_USERNAME: 'opencode',
  }),
}))

const replyQuestionMock = vi.fn()
const rejectQuestionMock = vi.fn()
const listQuestionsMock = vi.fn()
vi.mock('@/lib/dev-studio/opencode-rest', () => ({
  replyOpencodeQuestion: (...args: unknown[]) => replyQuestionMock(...args),
  rejectOpencodeQuestion: (...args: unknown[]) => rejectQuestionMock(...args),
  listOpencodeQuestions: (...args: unknown[]) => listQuestionsMock(...args),
}))

vi.mock('@/lib/dev-studio/coder-providers', () => ({
  getCoderProvider: (_type: string) => ({
    id: 'opencode',
    port: 4096,
    authHeader: (_env: unknown) => ({ Authorization: 'Basic dGVzdA==' }),
  }),
}))

const getEndpoint = vi.fn().mockResolvedValue('http://w')
const proxyHeaders = vi.fn().mockReturnValue({})
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    getEndpoint = getEndpoint
    proxyHeaders = proxyHeaders
  },
}))

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

const SESSION_ID = '44444444-4444-4444-4444-444444444444'
const USER_ID = 'user-question'

function opencodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    coderType: 'opencode' as const,
    activeContainerId: 'sbx-q',
    opencodeSessionId: 'oc_ses_q',
    ...overrides,
  }
}

function questionReq(body: Record<string, unknown> = {}): Request {
  return new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/question`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'q_req_1', answers: [['Option A']], ...body }),
  })
}

function getQuestionReq(): Request {
  return new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/question`, {
    method: 'GET',
  })
}

describe('POST /sessions/:id/question', () => {
  beforeEach(() => {
    replyQuestionMock.mockReset()
    replyQuestionMock.mockResolvedValue(undefined)
    rejectQuestionMock.mockReset()
    rejectQuestionMock.mockResolvedValue(undefined)
    listQuestionsMock.mockReset()
    listQuestionsMock.mockResolvedValue([])
    getEndpoint.mockClear()
    getEndpoint.mockResolvedValue('http://w')
    proxyHeaders.mockClear()
    proxyHeaders.mockReturnValue({})
    storeGet.mockReset()
    mockGetCurrentUserRole.mockReset()
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: USER_ID,
      role: 'member',
      error: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValueOnce({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 when session not found', async () => {
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session is not an opencode session', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ coderType: 'claudecode' }))
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 502 when activeContainerId is null', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ activeContainerId: null }))
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(502)
  })

  it('returns 400 on invalid body (empty requestId)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(questionReq({ requestId: '' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on missing body', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(
      new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { params: Promise.resolve({ sessionId: SESSION_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('calls replyOpencodeQuestion and returns 200 on reply path', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const answers = [['Option A'], ['Custom text']]
    const res = await POST(questionReq({ requestId: 'q_xyz', answers }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(replyQuestionMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'q_xyz',
      answers,
      undefined,
      undefined
    )
    expect(rejectQuestionMock).not.toHaveBeenCalled()
  })

  it('defaults answers to [] when answers field is omitted', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(
      new Request(`http://t/api/employee/dev-studio/sessions/${SESSION_ID}/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'q_empty' }),
      }),
      { params: Promise.resolve({ sessionId: SESSION_ID }) }
    )
    expect(res.status).toBe(200)
    expect(replyQuestionMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'q_empty',
      [],
      undefined,
      undefined
    )
  })

  it('calls rejectOpencodeQuestion and returns 200 on reject path', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const { POST } = await import('./route')
    const res = await POST(questionReq({ requestId: 'q_rej', reject: true }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    expect(rejectQuestionMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'q_rej',
      undefined,
      undefined
    )
    expect(replyQuestionMock).not.toHaveBeenCalled()
  })

  it('returns 502 when getEndpoint throws (sandbox unreachable)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    getEndpoint.mockRejectedValueOnce(new Error('timeout'))
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(502)
    expect(replyQuestionMock).not.toHaveBeenCalled()
  })

  it('returns 502 when replyOpencodeQuestion throws', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    replyQuestionMock.mockRejectedValueOnce(new Error('opencode question reply failed: 500'))
    const { POST } = await import('./route')
    const res = await POST(questionReq(), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(502)
  })
})

describe('GET /sessions/:id/question', () => {
  beforeEach(() => {
    listQuestionsMock.mockReset()
    listQuestionsMock.mockResolvedValue([])
    getEndpoint.mockClear()
    getEndpoint.mockResolvedValue('http://w')
    proxyHeaders.mockClear()
    proxyHeaders.mockReturnValue({})
    storeGet.mockReset()
    mockGetCurrentUserRole.mockReset()
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: USER_ID,
      role: 'member',
      error: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValueOnce({
      authenticated: false,
      userId: null,
      role: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 for non-opencode coderType', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ coderType: 'claudecode' }))
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 200 {questions:[]} when no activeContainerId', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ activeContainerId: null }))
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: unknown[] }
    expect(body.questions).toEqual([])
  })

  it('returns 200 {questions:[]} when opencodeSessionId is null', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession({ opencodeSessionId: null }))
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: unknown[] }
    expect(body.questions).toEqual([])
  })

  it('returns 200 {questions:[]} when getEndpoint throws (sandbox unreachable)', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    getEndpoint.mockRejectedValueOnce(new Error('timeout'))
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: unknown[] }
    expect(body.questions).toEqual([])
  })

  it('returns filtered questions matching opencodeSessionId', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    const matchingQuestion = {
      id: 'q_match',
      sessionID: 'oc_ses_q',
      questions: [{ question: 'Pick one', header: 'h', options: [] }],
    }
    const otherQuestion = {
      id: 'q_other',
      sessionID: 'oc_ses_other',
      questions: [],
    }
    listQuestionsMock.mockResolvedValueOnce([matchingQuestion, otherQuestion])
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: unknown[] }
    expect(body.questions).toHaveLength(1)
    expect((body.questions[0] as { id: string }).id).toBe('q_match')
  })

  it('returns 200 {questions:[]} when listOpencodeQuestions throws', async () => {
    storeGet.mockResolvedValueOnce(opencodeSession())
    listQuestionsMock.mockRejectedValueOnce(new Error('network error'))
    const { GET } = await import('./route')
    const res = await GET(getQuestionReq() as Parameters<typeof GET>[0], {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: unknown[] }
    expect(body.questions).toEqual([])
  })
})
