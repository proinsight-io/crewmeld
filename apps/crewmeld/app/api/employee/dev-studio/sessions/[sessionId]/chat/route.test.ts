/**
 * @vitest-environment node
 *
 * Phase 6 (Sub-spec B): chat route integrates marker / ask extractors,
 * persists every NDJSON frame to `tool_dev_messages`, drains queued system
 * notes before forwarding, tracks streaming lifecycle, and accumulates
 * token usage on `result` frames.
 *
 * Task 10: adds opencode branch tests — creates opencode session on first prompt,
 * calls promptOpencodeAsync, returns 202, skips tool_dev_messages persistence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    CREWMELD_SANDBOX_IMAGE: 'i',
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'http://anthropic',
    ANTHROPIC_MODEL: 'm',
    OPENCODE_SERVER_PASSWORD: 'pw',
    OPENCODE_SERVER_USERNAME: 'opencode',
  }),
}))

const createSessionMock = vi.fn()
const promptAsyncMock = vi.fn()
vi.mock('@/lib/dev-studio/opencode-rest', () => ({
  CREWMELD_OPENCODE_PROVIDER_ID: 'myprovider',
  createOpencodeSession: (...args: unknown[]) => createSessionMock(...args),
  promptOpencodeAsync: (...args: unknown[]) => promptAsyncMock(...args),
}))

const resolveModelEnvMock = vi.fn()
vi.mock('@/lib/dev-studio/model-resolver', () => ({
  resolveModelEnv: (...args: unknown[]) => resolveModelEnvMock(...args),
}))

// The opencode stub echoes the connection it was handed, so tests can assert
// the route resolved the bound connection and passed it through — the real
// composition of the section is persona-extensions' own business.
vi.mock('@/lib/dev-studio/persona-extensions', () => ({
  getDevStudioPersona: (_locale: string) => 'PERSONA_STUB',
  getOpencodeStudioInstructions: (
    _locale: string,
    conn?: { name: string; type: string; envKeys: string[] }
  ) => (conn ? `AGENTS_MD_STUB conn=${conn.name} keys=[${conn.envKeys.join(',')}]` : 'AGENTS_MD_STUB'),
}))

const resolveConnKeysMock = vi.fn()
vi.mock('@/lib/connectors/resolve-conn-env', () => ({
  resolveConnectionEnvKeys: (...args: unknown[]) => resolveConnKeysMock(...args),
}))

vi.mock('@/lib/dev-studio/coder-providers', () => ({
  getCoderProvider: (_type: string) => ({
    id: 'opencode',
    port: 4096,
    authHeader: (_env: unknown) => ({ Authorization: 'Basic dGVzdA==' }),
  }),
}))

const renew = vi.fn().mockResolvedValue(undefined)
const getEndpoint = vi.fn().mockResolvedValue('http://w')
const proxyHeaders = vi.fn().mockReturnValue({})
const execMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, durationMs: 5 })
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    renew = renew
    getEndpoint = getEndpoint
    proxyHeaders = proxyHeaders
    exec = execMock
  },
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeGet = vi.fn()
const storeUpdate = vi.fn().mockResolvedValue(undefined)
const storeMarkStreaming = vi.fn()
const storeDrainSystemNotes = vi.fn().mockReturnValue([])
const storeDrainUploadNotices = vi.fn().mockReturnValue([])
const storeHasActiveStreaming = vi.fn().mockReturnValue(false)
const storeUpdateLastMessagePreview = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    get: (...args: unknown[]) => storeGet(...args),
    update: (...args: unknown[]) => storeUpdate(...args),
    markStreaming: (...args: unknown[]) => storeMarkStreaming(...args),
    drainSystemNotes: (...args: unknown[]) => storeDrainSystemNotes(...args),
    drainUploadNotices: (...args: unknown[]) => storeDrainUploadNotices(...args),
    hasActiveStreaming: (...args: unknown[]) => storeHasActiveStreaming(...args),
    updateLastMessagePreview: (...args: unknown[]) => storeUpdateLastMessagePreview(...args),
  },
}))

/**
 * Drizzle fluent builder mock.
 *
 * `db.select().from(table).where(...).orderBy(...).limit(N)` resolves to whatever
 * `selectResult` was set to (an array of rows). `db.insert(table).values({...})`
 * resolves immediately; we capture the supplied values in `insertCalls`.
 */
type InsertCall = { table: unknown; values: unknown }
const insertCalls: InsertCall[] = []
let selectResult: unknown[] = []

vi.mock('@crewmeld/db', () => {
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(selectResult)),
    }
    return builder
  })
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      insertCalls.push({ table, values })
      return Promise.resolve(undefined)
    }),
  }))
  return {
    db: { select, insert },
    toolDevMessages: {
      __table: 'tool_dev_messages',
      sessionId: 'session_id',
      sequence: 'sequence',
    },
    toolDevPendingActions: { __table: 'tool_dev_pending_actions' },
    toolDevSessions: { __table: 'tool_dev_sessions' },
  }
})

const VALID_RID = '11111111-1111-1111-1111-111111111111'
const SESSION_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = 'user-1'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    title: null,
    status: 'active' as const,
    adoptedAt: null,
    pipelinePhases: null,
    phase: null,
    phaseHistory: [],
    activeContainerId: 'sbx-1',
    containerStatus: 'running' as const,
    workspaceDir: '/tmp/ws',
    claudeStateDir: '/tmp/cl',
    rightPanelVisible: false,
    approvedDependencies: { libraries: [], domains: [] },
    modelName: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    coderType: 'claudecode' as const,
    opencodeSessionId: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActiveAt: new Date(),
    ...overrides,
  }
}

function chatReq(body: Record<string, unknown> = {}): Request {
  return new Request('http://t', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', requestId: VALID_RID, ...body }),
  })
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

async function readAll(res: Response): Promise<string> {
  return await res.text()
}

describe('POST /sessions/:id/chat (Sub-spec B integration)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    renew.mockClear()
    renew.mockResolvedValue(undefined)
    getEndpoint.mockClear()
    getEndpoint.mockResolvedValue('http://w')
    proxyHeaders.mockClear()
    proxyHeaders.mockReturnValue({})
    execMock.mockReset()
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, durationMs: 5 })
    createSessionMock.mockReset()
    createSessionMock.mockResolvedValue({ id: 'ses_oc' })
    promptAsyncMock.mockReset()
    promptAsyncMock.mockResolvedValue(undefined)
    resolveModelEnvMock.mockReset()
    resolveModelEnvMock.mockResolvedValue({
      modelConfigId: 'mc-glm',
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
      ANTHROPIC_MODEL: 'glm-5',
      opencodeBaseURL: 'https://example.test/v1',
      opencodeApiKey: 'token',
      opencodeModelID: 'glm-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-5',
      displayLabel: '千帆编程 / glm-5',
    })
    resolveConnKeysMock.mockReset()
    resolveConnKeysMock.mockResolvedValue({
      name: 'mysql-1',
      type: 'database',
      envKeys: ['CONN_HOST', 'CONN_PORT', 'CONN_DATABASE', 'CONN_USERNAME', 'CONN_PASSWORD'],
    })
    mockGetCurrentUserRole.mockReset()
    storeGet.mockReset()
    storeUpdate.mockReset()
    storeUpdate.mockResolvedValue(undefined)
    storeMarkStreaming.mockReset()
    storeDrainSystemNotes.mockReset()
    storeDrainSystemNotes.mockReturnValue([])
    storeHasActiveStreaming.mockReset()
    storeHasActiveStreaming.mockReturnValue(false)
    storeUpdateLastMessagePreview.mockReset()
    storeUpdateLastMessagePreview.mockResolvedValue(undefined)
    insertCalls.length = 0
    selectResult = [{ max: null }]
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
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown sessionId', async () => {
    storeGet.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: 'nope' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to another user (no info leak)', async () => {
    storeGet.mockResolvedValueOnce(activeSession({ userId: 'other-user' }))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(404)
  })

  it('returns 409 when session has no active container', async () => {
    storeGet.mockResolvedValueOnce(
      activeSession({ activeContainerId: null, containerStatus: 'destroyed' })
    )
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(409)
  })

  it('returns 400 on malformed body', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const { POST } = await import('./route')
    const res = await POST(
      new Request('http://t', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      }),
      { params: Promise.resolve({ sessionId: SESSION_ID }) }
    )
    expect(res.status).toBe(400)
  })

  it('drains system note queue and prepends to user message', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    storeDrainSystemNotes.mockReturnValueOnce(['用户拒绝了 lib X', '请改用 Y'])
    fetchMock.mockResolvedValueOnce(ndjsonResponse(['{"type":"done"}']))
    const { POST } = await import('./route')
    await POST(chatReq({ message: 'help me build' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })

    expect(storeDrainSystemNotes).toHaveBeenCalledWith(SESSION_ID)
    const [, init] = fetchMock.mock.calls[0]
    const forwardedBody = JSON.parse((init as RequestInit).body as string)
    // New envelope: imperative header + raw notes (no '[系统]' prefix, the
    // notes already carry their own protocol tag like <answer id="...">) +
    // blank line + original user message.
    expect(forwardedBody.message).toContain('用户已对上一个 <ask> 给出答案')
    expect(forwardedBody.message).toContain('用户拒绝了 lib X')
    expect(forwardedBody.message).toContain('请改用 Y')
    expect(forwardedBody.message).toContain('help me build')
    expect(forwardedBody.workingDirectory).toBe('/root/workspace')
  })

  it('extracts <phase> from stream and updates the session', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const assistantFrame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [{ type: 'text', text: 'Starting now <phase>coding</phase> let us go' }],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([assistantFrame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })

    // Drain the stream to let the interceptor run all hooks.
    await readAll(res)

    const phaseUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).phase === 'coding'
    )
    expect(phaseUpdate).toBeDefined()
  })

  it('extracts <title> only when session.title is currently null', async () => {
    storeGet.mockResolvedValueOnce(activeSession({ title: 'existing' }))
    const frame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [{ type: 'text', text: '<title>shiny new</title>' }],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const titleUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).title !== undefined
    )
    expect(titleUpdate).toBeUndefined()
  })

  it('extracts <title> and writes session.title when previously null', async () => {
    storeGet.mockResolvedValueOnce(activeSession({ title: null }))
    const frame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [{ type: 'text', text: '<title>my tool</title>' }],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const titleUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).title === 'my tool'
    )
    expect(titleUpdate).toBeDefined()
  })

  it('extracts <pipeline> and appends "adoption" when missing', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const frame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [
          { type: 'text', text: '<pipeline>["requirement","design","coding"]</pipeline>' },
        ],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const pipelineUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).pipelinePhases !== undefined
    )
    expect(pipelineUpdate).toBeDefined()
    expect((pipelineUpdate![1] as Record<string, unknown>).pipelinePhases).toEqual([
      'requirement',
      'design',
      'coding',
      'adoption',
    ])
  })

  it('extracts <pipeline> and keeps "adoption" untouched when AI already terminated with it', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const frame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [{ type: 'text', text: '<pipeline>["A","B","adoption"]</pipeline>' }],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const pipelineUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).pipelinePhases !== undefined
    )
    expect((pipelineUpdate![1] as Record<string, unknown>).pipelinePhases).toEqual([
      'A',
      'B',
      'adoption',
    ])
  })

  it('extracts <ask> and inserts a pending_actions row', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const askJson = JSON.stringify({
      question: '选哪个？',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    })
    const frame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: `<ask id="q1" type="choice">${askJson}</ask>`,
          },
        ],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const pendingInsert = insertCalls.find(
      (call) => (call.values as Record<string, unknown>).askId === 'q1'
    )
    expect(pendingInsert).toBeDefined()
    expect((pendingInsert!.values as Record<string, unknown>).type).toBe('choice')
    expect((pendingInsert!.values as Record<string, unknown>).status).toBe('pending')
  })

  it('persists each NDJSON message to tool_dev_messages with monotonic sequence', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    selectResult = [{ max: 10 }]
    const frames = [
      JSON.stringify({
        type: 'claude_json',
        data: {
          type: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      }),
      JSON.stringify({
        type: 'claude_json',
        data: {
          type: 'result',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]
    fetchMock.mockResolvedValueOnce(ndjsonResponse([...frames, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const messageInserts = insertCalls.filter(
      (call) =>
        (call.table as Record<string, unknown>).__table === 'tool_dev_messages' &&
        typeof (call.values as Record<string, unknown>).sequence === 'number'
    )
    expect(messageInserts.length).toBeGreaterThanOrEqual(3) // user + assistant + result
    const sequences = messageInserts.map(
      (call) => (call.values as Record<string, unknown>).sequence as number
    )
    // Monotonic + starts after the previously stored max (10).
    expect(sequences[0]).toBe(11)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1] + 1)
    }
  })

  it('accumulates totalInputTokens / totalOutputTokens from result frames', async () => {
    storeGet.mockResolvedValueOnce(activeSession({ totalInputTokens: 100, totalOutputTokens: 50 }))
    const resultFrame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'result',
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([resultFrame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    await readAll(res)
    const tokenUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).totalInputTokens !== undefined
    )
    expect(tokenUpdate).toBeDefined()
    expect((tokenUpdate![1] as Record<string, unknown>).totalInputTokens).toBe(107)
    expect((tokenUpdate![1] as Record<string, unknown>).totalOutputTokens).toBe(53)
  })

  it('detects manifest Write tool_use and logs file activity (no crash)', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const writeFrame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Write',
            input: { file_path: '/root/workspace/.dev-studio/manifest.json', content: '{}' },
          },
        ],
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([writeFrame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    const body = await readAll(res)
    // We don't yet ship SSE; ensure stream completes cleanly.
    expect(body).toContain('"type":"done"')
  })

  it('toggles markStreaming(true) on entry and markStreaming(false) on stream completion', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockResolvedValueOnce(ndjsonResponse(['{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    // Must mark true synchronously inside the handler so concurrent requests see it.
    expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, true)
    // Drain to trigger the TransformStream flush hook.
    await readAll(res)
    expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, false)
  })

  it('returns 502 when upstream webui fails and clears the streaming flag', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockResolvedValueOnce(new Response('crashed', { status: 500 }))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    expect(res.status).toBe(502)
    expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, false)
  })

  it('forwards workingDirectory=/root/workspace regardless of body', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    fetchMock.mockResolvedValueOnce(ndjsonResponse(['{"type":"done"}']))
    const { POST } = await import('./route')
    await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    const [, init] = fetchMock.mock.calls[0]
    const forwardedBody = JSON.parse((init as RequestInit).body as string)
    expect(forwardedBody.workingDirectory).toBe('/root/workspace')
  })

  it('clears streaming flag when the client cancels the response reader', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    // Two frames so we can read one then cancel before the upstream "done"
    // frame would naturally close the stream.
    const frames = [
      JSON.stringify({
        type: 'claude_json',
        data: {
          type: 'assistant',
          content: [{ type: 'text', text: 'first chunk' }],
        },
      }),
      JSON.stringify({
        type: 'claude_json',
        data: {
          type: 'assistant',
          content: [{ type: 'text', text: 'second chunk' }],
        },
      }),
    ]
    fetchMock.mockResolvedValueOnce(ndjsonResponse(frames))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })

    expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, true)

    // Pull one chunk to make sure the pipeline is live, then cancel as a real
    // browser tab close would — this triggers Transformer.cancel, NOT flush.
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel('client-disconnect')

    // Give the lifecycle tail a microtask to fire its cancel hook.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, false)
  })

  it('survives a thrown extractor exception and still clears the streaming flag', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    // Reach into the already-mocked MarkerExtractor module and force `consume`
    // to throw on the next assistant_text frame. The route must catch this,
    // pass the raw message through to the client, and the lifecycle tail
    // must still flip streaming back to false at stream end.
    const markerModule = await import('@/lib/dev-studio/phase-marker-extractor')
    const originalConsume = markerModule.MarkerExtractor.prototype.consume
    const consumeSpy = vi
      .spyOn(markerModule.MarkerExtractor.prototype, 'consume')
      .mockImplementation(() => {
        throw new Error('boom: bad regex input')
      })

    try {
      const rawText = 'hello world (would normally be processed)'
      const frame = JSON.stringify({
        type: 'claude_json',
        data: {
          type: 'assistant',
          content: [{ type: 'text', text: rawText }],
        },
      })
      fetchMock.mockResolvedValueOnce(ndjsonResponse([frame, '{"type":"done"}']))
      const { POST } = await import('./route')
      const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })

      const body = await readAll(res)

      // Lifecycle hook must have fired despite the thrown extractor.
      expect(storeMarkStreaming).toHaveBeenCalledWith(SESSION_ID, false)

      // Raw text reaches the client unmodified — degraded extraction
      // beats a hung session.
      expect(body).toContain(rawText)
      // And the spy actually fired (sanity that we exercised the path).
      expect(consumeSpy).toHaveBeenCalled()
    } finally {
      consumeSpy.mockRestore()
      // Defensive: ensure prototype is back to the real impl for any
      // subsequent tests in this file.
      markerModule.MarkerExtractor.prototype.consume = originalConsume
    }
  })

  /**
   * Regression guard: the real Claude SDK nests content under `message.content`,
   * not at the top level. Earlier revisions of route.ts read `msg.content`
   * directly and silently dropped every assistant payload in production while
   * the test fixtures (which used the legacy top-level shape) all passed.
   * This test pins the envelope shape so we notice if the helper regresses.
   */
  it('extracts <phase> + <ask> from real SDK envelope shape (message.content)', async () => {
    storeGet.mockResolvedValueOnce(activeSession())
    const askJson = JSON.stringify({
      question: '选哪个？',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    })
    const envelopeFrame = JSON.stringify({
      type: 'claude_json',
      data: {
        type: 'assistant',
        // Real SDK shape: content lives under `message.content`, NOT
        // top-level. The route's getContent() helper must follow this.
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `ok <phase>coding</phase> <ask id="q9" type="choice">${askJson}</ask> next`,
            },
          ],
        },
      },
    })
    fetchMock.mockResolvedValueOnce(ndjsonResponse([envelopeFrame, '{"type":"done"}']))
    const { POST } = await import('./route')
    const res = await POST(chatReq(), { params: Promise.resolve({ sessionId: SESSION_ID }) })
    const body = await readAll(res)

    // <phase> made it into a session row patch.
    const phaseUpdate = storeUpdate.mock.calls.find(
      ([, patch]) => (patch as Record<string, unknown>).phase === 'coding'
    )
    expect(phaseUpdate).toBeDefined()

    // <ask> made it into a pending_actions row.
    const pendingInsert = insertCalls.find(
      (c) => (c.table as { __table?: string }).__table === 'tool_dev_pending_actions'
    )
    expect(pendingInsert).toBeDefined()
    expect((pendingInsert?.values as { askId: string }).askId).toBe('q9')

    // <phase> is protocol — must be stripped before reaching the client.
    expect(body).not.toContain('<phase>')
    // <ask> is intentionally NOT stripped here — the frontend's own
    // AskExtractor parses the raw tag to render an inline card in the
    // chat bubble. pending_actions persistence already happened above.
    expect(body).toContain('<ask')
  })

  describe('opencode branch', () => {
    const P = Promise.resolve({ sessionId: SESSION_ID })

    function makeReq(body: Record<string, unknown> = {}): Request {
      return new Request('http://t', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', requestId: VALID_RID, ...body }),
      })
    }

    it('creates opencode session on first prompt, calls promptOpencodeAsync, returns 202, skips persist', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: null })
      )
      createSessionMock.mockResolvedValueOnce({ id: 'ses_oc' })
      promptAsyncMock.mockResolvedValueOnce(undefined)
      mockGetCurrentUserRole.mockResolvedValue({
        authenticated: true,
        userId: USER_ID,
        role: 'member',
        error: null,
      })

      const { POST } = await import('./route')
      const res = await POST(makeReq({ message: 'hello' }), { params: P })

      expect(res.status).toBe(202)
      expect(createSessionMock).toHaveBeenCalled()
      expect(promptAsyncMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'ses_oc',
        expect.stringContaining('hello'),
        { providerID: 'myprovider', modelID: 'glm-5' },
      )
      // Must NOT insert into tool_dev_messages
      const devMsgInserts = insertCalls.filter(
        (c) => (c.table as { __table?: string }).__table === 'tool_dev_messages'
      )
      expect(devMsgInserts).toHaveLength(0)
      // Must persist the new opencodeSessionId onto the session row
      expect(storeUpdate).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ opencodeSessionId: 'ses_oc' }),
      )
    })

    it('reuses existing opencodeSessionId without calling createOpencodeSession', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: 'existing_id' })
      )
      promptAsyncMock.mockResolvedValueOnce(undefined)
      mockGetCurrentUserRole.mockResolvedValue({
        authenticated: true,
        userId: USER_ID,
        role: 'member',
        error: null,
      })

      const { POST } = await import('./route')
      const res = await POST(makeReq({ message: 'hello' }), { params: P })

      expect(res.status).toBe(202)
      expect(createSessionMock).not.toHaveBeenCalled()
      expect(promptAsyncMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'existing_id',
        expect.stringContaining('hello'),
        { providerID: 'myprovider', modelID: 'glm-5' },
      )
    })

    it('returns 502 when activeContainerId is missing for opencode session', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: null, activeContainerId: null })
      )
      mockGetCurrentUserRole.mockResolvedValue({
        authenticated: true,
        userId: USER_ID,
        role: 'member',
        error: null,
      })

      const { POST } = await import('./route')
      const res = await POST(makeReq(), { params: P })

      expect(res.status).toBe(502)
      expect(createSessionMock).not.toHaveBeenCalled()
    })

    it('first message — promptOpencodeAsync receives plain user message (no persona prepend)', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: null })
      )
      createSessionMock.mockResolvedValueOnce({ id: 'ses_oc' })
      promptAsyncMock.mockResolvedValueOnce(undefined)

      const { POST } = await import('./route')
      await POST(makeReq({ message: 'build me a widget' }), { params: P })

      const [, , , promptArg] = promptAsyncMock.mock.calls[0] as [unknown, unknown, unknown, string]
      // Persona must NOT appear in the prompt — instructions go to AGENTS.md
      expect(promptArg).not.toContain('PERSONA_STUB')
      expect(promptArg).not.toContain('AGENTS_MD_STUB')
      expect(promptArg).toContain('build me a widget')
    })

    it('first message — exec called to write AGENTS.md on first message', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: null })
      )
      createSessionMock.mockResolvedValueOnce({ id: 'ses_oc' })
      promptAsyncMock.mockResolvedValueOnce(undefined)

      const { POST } = await import('./route')
      await POST(makeReq({ message: 'build me a widget' }), { params: P })

      // Give the fire-and-forget promise a tick to settle
      await Promise.resolve()

      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: ['sh', '-c', expect.stringContaining('AGENTS.md')],
          stdin: 'AGENTS_MD_STUB',
        })
      )
    })

    // AGENTS.md is rewritten on EVERY turn, not just the first. opencode
    // re-reads it per prompt, and that is the only thing that lets a connection
    // bound (or swapped) after the first message reach the model — the operator
    // typically picks the connection once the conversation is already going.
    it('subsequent message — AGENTS.md is rewritten again', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: 'existing_session' })
      )
      promptAsyncMock.mockResolvedValueOnce(undefined)

      const { POST } = await import('./route')
      await POST(makeReq({ message: 'follow-up question' }), { params: P })

      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: ['sh', '-c', expect.stringContaining('AGENTS.md')],
        })
      )
    })

    it('subsequent message — promptOpencodeAsync receives user message', async () => {
      storeGet.mockResolvedValueOnce(
        activeSession({ coderType: 'opencode', opencodeSessionId: 'existing_session' })
      )
      promptAsyncMock.mockResolvedValueOnce(undefined)

      const { POST } = await import('./route')
      await POST(makeReq({ message: 'follow-up question' }), { params: P })

      const [, , , promptArg] = promptAsyncMock.mock.calls[0] as [unknown, unknown, unknown, string]
      expect(promptArg).not.toContain('PERSONA_STUB')
      expect(promptArg).not.toContain('AGENTS_MD_STUB')
      expect(promptArg).toContain('follow-up question')
    })

    /**
     * The bound connection's real CONN_* names have to reach the model. Told
     * only "read credentials from CONN_*", it guesses `CONN_USER` while the
     * sandbox injects `CONN_USERNAME`, and the tool then connects as the
     * container's OS user against credentials that were present all along.
     */
    describe('bound connection', () => {
      /** stdin of the last exec that wrote AGENTS.md. */
      function agentsMdWritten(): string | undefined {
        const call = execMock.mock.calls.findLast(([arg]) =>
          String((arg as { cmd: string[] }).cmd?.[2] ?? '').includes('AGENTS.md')
        )
        return call ? (call[0] as { stdin?: string }).stdin : undefined
      }

      it("names the connection's real CONN_* variables in AGENTS.md", async () => {
        storeGet.mockResolvedValueOnce(
          activeSession({
            coderType: 'opencode',
            opencodeSessionId: null,
            connectionId: 'conn_1',
          })
        )

        const { POST } = await import('./route')
        await POST(makeReq({ message: 'query sales' }), { params: P })

        expect(resolveConnKeysMock).toHaveBeenCalledWith('conn_1')
        expect(agentsMdWritten()).toContain('CONN_USERNAME')
        expect(agentsMdWritten()).toContain('conn=mysql-1')
      })

      it('picks up a connection bound after the conversation started', async () => {
        storeGet.mockResolvedValueOnce(
          activeSession({
            coderType: 'opencode',
            opencodeSessionId: 'existing_session',
            connectionId: 'conn_1',
          })
        )

        const { POST } = await import('./route')
        await POST(makeReq({ message: 'now use the db' }), { params: P })

        expect(agentsMdWritten()).toContain('CONN_USERNAME')
      })

      it('writes AGENTS.md before prompting, so the turn cannot race the write', async () => {
        const order: string[] = []
        execMock.mockImplementation(async () => {
          order.push('exec')
          return { stdout: '', stderr: '', exitCode: 0, durationMs: 5 }
        })
        promptAsyncMock.mockImplementation(async () => {
          order.push('prompt')
        })
        storeGet.mockResolvedValueOnce(
          activeSession({
            coderType: 'opencode',
            opencodeSessionId: 'existing_session',
            connectionId: 'conn_1',
          })
        )

        const { POST } = await import('./route')
        await POST(makeReq({ message: 'go' }), { params: P })

        expect(order).toEqual(['exec', 'prompt'])
      })

      it('omits the connection section when no connection is bound', async () => {
        storeGet.mockResolvedValueOnce(
          activeSession({ coderType: 'opencode', opencodeSessionId: null, connectionId: null })
        )

        const { POST } = await import('./route')
        await POST(makeReq({ message: 'build a widget' }), { params: P })

        expect(resolveConnKeysMock).not.toHaveBeenCalled()
        expect(agentsMdWritten()).toBe('AGENTS_MD_STUB')
      })

      /**
       * An unresolvable connection must not take the turn down with it, and
       * must not produce a section listing no variables — that reads to the
       * model as "this connection injects nothing".
       */
      it('still writes the base instructions when the connection cannot be resolved', async () => {
        resolveConnKeysMock.mockRejectedValueOnce(new Error('decrypt failed'))
        storeGet.mockResolvedValueOnce(
          activeSession({
            coderType: 'opencode',
            opencodeSessionId: null,
            connectionId: 'conn_broken',
          })
        )

        const { POST } = await import('./route')
        const res = await POST(makeReq({ message: 'query sales' }), { params: P })

        expect(res.status).not.toBe(502)
        expect(agentsMdWritten()).toBe('AGENTS_MD_STUB')
        expect(promptAsyncMock).toHaveBeenCalled()
      })
    })
  })
})
