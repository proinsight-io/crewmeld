/**
 * @vitest-environment node
 *
 * Tests for POST /api/tools/[instanceId]/invoke.
 *
 * Focus: tool_executions row persistence + execId emission for script-type
 * instances (Task 22). Boundaries mocked: db query/insert chains, api-key
 * hashing, and the script invoker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockHashApiKey = vi.fn().mockReturnValue('hashed-key')
vi.mock('@/lib/tools/api-key-service', () => ({
  hashApiKey: (...args: unknown[]) => mockHashApiKey(...args),
}))

const mockGenerateExecutionId = vi.fn()
vi.mock('@/lib/core/execution-id', () => ({
  generateExecutionId: (...args: unknown[]) => mockGenerateExecutionId(...args),
}))

const mockInvokeScriptTool = vi.fn()
vi.mock('@/lib/tools/script-invoker', () => ({
  invokeScriptTool: (...args: unknown[]) => mockInvokeScriptTool(...args),
}))

const mockRunApiTool = vi.fn()
vi.mock('@/lib/tools/api-tool-runner', () => ({
  runApiTool: (...args: unknown[]) => mockRunApiTool(...args),
}))
vi.mock('@/lib/tools/api-tool-deps', () => ({
  buildApiToolDeps: () => ({}),
}))
vi.mock('@/lib/tools/service-replica-selector', () => ({
  selectServiceReplica: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  getOpenSandboxClient: () => ({
    proxyHeaders: () => ({ 'OPEN-SANDBOX-API-KEY': 'platform-sandbox-key' }),
  }),
}))

/**
 * `db` is a multi-shape proxy. The route makes:
 *   1. SELECT api key  → resolves rows
 *   2. UPDATE api key  → fire-and-forget
 *   3. SELECT instance → resolves rows
 *   4. INSERT tool_executions (script branch only)
 */
const apiKeyRows: unknown[] = []
const instanceRows: unknown[] = []
const insertSpy = vi.fn()

let selectCallIdx = 0
vi.mock('@crewmeld/db', () => {
  const select = vi.fn(() => {
    const idx = selectCallIdx++
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(idx === 0 ? instanceRows : apiKeyRows)),
    }
    return builder
  })
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        catch: vi.fn(),
      })),
    })),
  }))
  const insert = vi.fn((...args: unknown[]) => {
    insertSpy(...args)
    return { values: vi.fn().mockResolvedValue(undefined) }
  })
  return {
    db: { select, update, insert },
    toolExecutions: { __table: 'tool_executions' },
    toolInstanceApiKeys: { __table: 'tool_instance_api_keys' },
    toolInstances: { __table: 'tool_instances' },
    tools: { __table: 'tools' },
  }
})

function makeReq(
  body: unknown,
  opts: { apiKey?: string | null; extraHeaders?: Record<string, string> } = {}
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.apiKey !== null) {
    headers['X-API-Key'] = opts.apiKey ?? 'test-key'
  }
  Object.assign(headers, opts.extraHeaders ?? {})
  return new Request('http://test/api/tools/inst-1/invoke', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const CTX = { params: Promise.resolve({ instanceId: 'inst-1' }) }

describe('POST /api/tools/[instanceId]/invoke', () => {
  beforeEach(() => {
    selectCallIdx = 0
    apiKeyRows.length = 0
    instanceRows.length = 0
    insertSpy.mockReset()
    mockHashApiKey.mockClear()
    mockGenerateExecutionId.mockReset()
    mockInvokeScriptTool.mockReset()
    mockRunApiTool.mockReset()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns 401 without an API key', async () => {
    instanceRows.push({
      id: 'inst-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
    })
    const { POST } = await import('./route')
    const res = await POST(makeReq({ input: {} }, { apiKey: null }) as never, CTX)
    expect(res.status).toBe(401)
  })

  it('returns 401 when no matching api key row', async () => {
    instanceRows.push({
      id: 'inst-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
    })
    apiKeyRows.length = 0
    const { POST } = await import('./route')
    const res = await POST(makeReq({ input: {} }) as never, CTX)
    expect(res.status).toBe(401)
  })

  it('allows an anonymous published API tool without an API key', async () => {
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'anonymous',
      kind: 'api',
      apiSpec: { pre: 'return {}', request: { connectionId: 'c1' }, post: 'return {}' },
      forwardIdentity: false,
    })
    mockRunApiTool.mockResolvedValue({ success: true, result: { ok: true } })
    const { POST } = await import('./route')
    const response = await POST(makeReq({ input: {} }, { apiKey: null }) as never, CTX)
    expect(response.status).toBe(200)
    expect(mockHashApiKey).not.toHaveBeenCalled()
  })

  it('returns 404 when instance missing', async () => {
    instanceRows.length = 0
    const { POST } = await import('./route')
    const res = await POST(makeReq({ input: {} }) as never, CTX)
    expect(res.status).toBe(404)
  })

  it('persists tool_executions and forwards execId to script invoker', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
      deploy: { status: 'deployed', deployType: 'opensandbox-script' },
      envVars: [{ name: 'API_KEY', value: 'secret' }],
      createdBy: 'user-42',
    })
    mockGenerateExecutionId.mockReturnValue('inv_20260528_abc123def456')
    mockInvokeScriptTool.mockResolvedValue({
      success: true,
      result: { stdout: 'ok' },
      executionTime: 5,
    })

    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: { q: 'x' } }, { extraHeaders: { TEST: 'yfy' } }) as never,
      CTX
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; executionId: string }
    expect(body.success).toBe(true)
    expect(body.executionId).toBe('inv_20260528_abc123def456')

    // tool_executions row was inserted with the right shape
    expect(insertSpy).toHaveBeenCalledTimes(1)
    // Script invoker was passed the same execId so the io dir aligns, and the
    // caller's forwarded headers (minus stripped X-API-Key) are passed through.
    expect(mockInvokeScriptTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'tpl-1',
        execId: 'inv_20260528_abc123def456',
        userEnv: { API_KEY: 'secret' },
        headers: { test: 'yfy' },
      })
    )
  })

  it('forwards filtered inbound headers to the API tool runner', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
      deploy: null,
      envVars: null,
      createdBy: 'user-1',
      kind: 'api',
      apiSpec: { pre: 'return {}', request: { connectionId: 'c1' }, post: 'return {}' },
      forwardIdentity: false,
    })
    mockRunApiTool.mockResolvedValue({ success: true, result: { ok: 1 } })

    const { POST } = await import('./route')
    const res = await POST(
      makeReq({ input: { a: 1 } }, { extraHeaders: { TEST: 'yfy', host: 'evil' } }) as never,
      CTX
    )
    expect(res.status).toBe(200)
    expect(mockRunApiTool).toHaveBeenCalledTimes(1)
    const opts = mockRunApiTool.mock.calls[0][3] as { headers: Record<string, string> }
    expect(opts.headers.test).toBe('yfy')
    // x-api-key (platform secret) and host (hop-by-hop) are stripped
    expect('x-api-key' in opts.headers).toBe(false)
    expect('host' in opts.headers).toBe(false)
  })

  it('returns 403 when instance not published as API', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: false,
      serviceAuthMode: 'api-key',
      deploy: { status: 'deployed', deployType: 'opensandbox-script' },
      envVars: null,
      createdBy: 'user-1',
    })

    const { POST } = await import('./route')
    const res = await POST(makeReq({ input: {} }) as never, CTX)
    expect(res.status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 503 when tool not deployed', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
      deploy: { status: 'pending' },
      envVars: null,
      createdBy: 'user-1',
    })

    const { POST } = await import('./route')
    const res = await POST(makeReq({ input: {} }) as never, CTX)
    expect(res.status).toBe(503)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('forwards custom inbound headers to the service proxy but strips platform/hop-by-hop headers', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
      deploy: {
        status: 'deployed',
        deployType: 'opensandbox',
        endpoint: 'http://sandbox/run',
        useProxy: true,
      },
      envVars: null,
      createdBy: 'user-1',
    })
    vi.stubEnv('OPENSANDBOX_API_KEY', 'platform-sandbox-key')
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchSpy)

    const req = new Request('http://test/api/tools/inst-1/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': 'cmk_caller',
        TEST: 'yfy',
        'X-Custom': 'abc',
        Authorization: 'Bearer downstream',
        'open-sandbox-api-key': 'attacker-injected',
        host: 'evil.example',
      },
      body: JSON.stringify({ input: { param1: '1' } }),
    })

    const { POST } = await import('./route')
    const res = await POST(req as never, CTX)
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const opts = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }
    const sent = opts.headers
    // Custom inbound headers are forwarded (keys lowercased by the Headers API)
    expect(sent.test).toBe('yfy')
    expect(sent['x-custom']).toBe('abc')
    // Authorization (downstream auth) is forwarded
    expect(sent.authorization).toBe('Bearer downstream')
    // Platform API key is stripped — never leaked to the tool backend
    expect('x-api-key' in sent).toBe(false)
    // Hop-by-hop headers are stripped
    expect('host' in sent).toBe(false)
    // open-sandbox-api-key uses the platform env value, not the caller-injected one
    expect(sent['OPEN-SANDBOX-API-KEY']).toBe('platform-sandbox-key')
    expect('open-sandbox-api-key' in sent).toBe(false)
    // Content-Type is controlled by the proxy
    expect(sent['Content-Type']).toBe('application/json')
  })

  it('returns 422 when body has no input field', async () => {
    apiKeyRows.push({ id: 'k1' })
    instanceRows.push({
      id: 'inst-1',
      templateId: 'tpl-1',
      publishedAsService: true,
      serviceAuthMode: 'api-key',
      deploy: { status: 'deployed', deployType: 'opensandbox-script' },
      envVars: null,
      createdBy: 'user-1',
    })

    const { POST } = await import('./route')
    const res = await POST(makeReq({ no: 'input' }) as never, CTX)
    expect(res.status).toBe(422)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
