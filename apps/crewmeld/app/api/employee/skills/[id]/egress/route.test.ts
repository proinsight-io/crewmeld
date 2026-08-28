/**
 * @vitest-environment node
 *
 * Tests for PUT /api/employee/skills/:id/egress — the instance-editor egress
 * allow-list writer. Persists `dependencies.domains` (FQDN) + `dependencies.ips`
 * into the tool's manifest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requirePermission = vi.fn()
vi.mock('@/lib/auth/rbac/check-permission', () => ({
  requirePermission: () => requirePermission(),
}))

const setToolManifestEgress = vi.fn()
vi.mock('@/lib/dev-studio/manifest-reader', () => ({
  setToolManifestEgress: (...args: unknown[]) => setToolManifestEgress(...args),
}))

function authed() {
  requirePermission.mockResolvedValue({ authenticated: true, userId: 'u1', error: null })
}

function putReq(body: unknown): Request {
  return new Request('http://test/api/employee/skills/tool-1/egress', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ id: 'tool-1' }) }

describe('PUT /api/employee/skills/:id/egress', () => {
  beforeEach(() => {
    requirePermission.mockReset()
    setToolManifestEgress.mockReset()
  })

  it('401/403 when lacking skill:edit', async () => {
    requirePermission.mockResolvedValue({
      authenticated: false,
      error: 'api.common.unauthorized',
    })
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: [], ips: [] }), ctx)
    expect(res.status).toBe(401)
    expect(setToolManifestEgress).not.toHaveBeenCalled()
  })

  it('persists domains + ips and echoes them', async () => {
    authed()
    setToolManifestEgress.mockResolvedValue({
      dependencies: { libraries: ['x'], domains: ['api.example.com'], ips: ['10.0.0.0/24'] },
    })
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: ['api.example.com'], ips: ['10.0.0.0/24'] }), ctx)
    expect(res.status).toBe(200)
    expect(setToolManifestEgress).toHaveBeenCalledWith('tool-1', {
      domains: ['api.example.com'],
      ips: ['10.0.0.0/24'],
    })
    const body = (await res.json()) as { data: { domains: string[]; ips: string[] } }
    expect(body.data).toEqual({ domains: ['api.example.com'], ips: ['10.0.0.0/24'] })
  })

  it('rejects a non-FQDN domain (IPs must go in the ip list)', async () => {
    authed()
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: ['10.0.0.5'], ips: [] }), ctx)
    expect(res.status).toBe(400)
    expect(setToolManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 400 on bad body shape', async () => {
    authed()
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: 'nope' }), ctx)
    expect(res.status).toBe(400)
    expect(setToolManifestEgress).not.toHaveBeenCalled()
  })

  it('returns 404 when the tool has no manifest', async () => {
    authed()
    setToolManifestEgress.mockRejectedValue(
      new Error('CONFLICT: manifest does not exist; cannot edit egress')
    )
    const { PUT } = await import('./route')
    const res = await PUT(putReq({ domains: ['api.example.com'], ips: [] }), ctx)
    expect(res.status).toBe(404)
  })
})
