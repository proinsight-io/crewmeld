/**
 * @vitest-environment node
 *
 * Tests for POST /api/employee/skills/instances/:id/test-run.
 *
 * Focus: the manifest-kind branch — service tools now run via invokeServiceTool
 * instead of being rejected; script tools keep using invokeScriptTool.
 *
 * Boundaries mocked: auth + db + connection env + manifest reader + both invokers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequirePermission = vi.fn()
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}))

// db.select(...).from(...).where(...).limit(1) → resolves to the next queued array.
const selectResults: unknown[][] = []
vi.mock('@crewmeld/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResults.shift() ?? []),
        }),
      }),
    }),
  },
  toolInstances: {},
  tools: {},
}))

const mockResolveConnEnv = vi.fn()
vi.mock('@/lib/connectors/resolve-conn-env', () => ({
  resolveConnectionEnvVars: (...args: unknown[]) => mockResolveConnEnv(...args),
}))

const mockReadManifest = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  readManifestFromTool: (...args: unknown[]) => mockReadManifest(...args),
}))

const mockInvokeScript = vi.fn()
vi.mock('@/lib/tools/script-invoker', () => ({
  invokeScriptTool: (...args: unknown[]) => mockInvokeScript(...args),
}))

const mockInvokeService = vi.fn()
vi.mock('@/lib/tools/service-invoker', () => ({
  invokeServiceTool: (...args: unknown[]) => mockInvokeService(...args),
}))

import { POST } from './route'

const CTX = { params: Promise.resolve({ id: 'inst-1' }) }

function makeReq(body: unknown): Request {
  return new Request('http://test/api/employee/skills/instances/inst-1/test-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Queue the instance row + template row the route reads (in that order). */
function queueRows(source: string): void {
  selectResults.length = 0
  selectResults.push([{ id: 'inst-1', templateId: 'tool-1', connectionId: null, envVars: null }])
  selectResults.push([{ source, envVars: null }])
}

beforeEach(() => {
  vi.clearAllMocks()
  selectResults.length = 0
  mockRequirePermission.mockResolvedValue({ authenticated: true, error: null, userId: 'user-1' })
  mockResolveConnEnv.mockResolvedValue({})
  mockInvokeScript.mockResolvedValue({ success: true, result: { ok: 'script' }, executionTime: 1 })
  mockInvokeService.mockResolvedValue({
    success: true,
    result: { ok: 'service' },
    httpStatus: 200,
    executionTime: 1,
  })
})

describe('POST instances/:id/test-run kind branching', () => {
  it('rejects non-dev-studio tools', async () => {
    queueRows('installed')
    const res = await POST(makeReq({ input: {} }), CTX)
    const json = (await res.json()) as { success: boolean; error: string }
    expect(res.status).toBe(400)
    expect(json.success).toBe(false)
    expect(mockInvokeScript).not.toHaveBeenCalled()
    expect(mockInvokeService).not.toHaveBeenCalled()
  })

  it('routes script-kind tools to invokeScriptTool', async () => {
    queueRows('dev-studio')
    mockReadManifest.mockResolvedValue({ kind: 'script', input: {} })
    const res = await POST(makeReq({ input: { a: 1 } }), CTX)
    const json = (await res.json()) as { success: boolean; result: unknown }
    expect(json.success).toBe(true)
    expect(json.result).toEqual({ ok: 'script' })
    expect(mockInvokeScript).toHaveBeenCalledTimes(1)
    expect(mockInvokeService).not.toHaveBeenCalled()
    expect(mockInvokeScript.mock.calls[0][0]).toMatchObject({ toolId: 'tool-1', input: { a: 1 } })
  })

  it('routes service-kind tools to invokeServiceTool (no longer a 400)', async () => {
    queueRows('dev-studio')
    mockReadManifest.mockResolvedValue({
      kind: 'service',
      input: {},
      service: { port: 8000, path: '/run', method: 'POST' },
    })
    const res = await POST(makeReq({ input: { a: 1 } }), CTX)
    const json = (await res.json()) as { success: boolean; result: unknown }
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.result).toEqual({ ok: 'service' })
    expect(mockInvokeService).toHaveBeenCalledTimes(1)
    expect(mockInvokeScript).not.toHaveBeenCalled()
    expect(mockInvokeService.mock.calls[0][0]).toMatchObject({ toolId: 'tool-1', input: { a: 1 } })
  })

  it('returns 404 when the manifest is missing on NFS', async () => {
    queueRows('dev-studio')
    mockReadManifest.mockResolvedValue(null)
    const res = await POST(makeReq({ input: {} }), CTX)
    expect(res.status).toBe(404)
    expect(mockInvokeScript).not.toHaveBeenCalled()
    expect(mockInvokeService).not.toHaveBeenCalled()
  })
})
