/**
 * @vitest-environment node
 *
 * Tests for GET /api/employee/dev-studio/egress-mode — a lightweight,
 * authenticated lookup of the admin global egress mode so the dev-studio test
 * panel can hide the per-run 临时白名单 input in unrestricted mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const getSandboxSettings = vi.fn()
vi.mock('@/lib/sandbox/settings', () => ({
  getSandboxSettings: () => getSandboxSettings(),
}))

describe('GET /api/employee/dev-studio/egress-mode', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    getSandboxSettings.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: false,
      userId: null,
      error: 'api.common.unauthorized',
    })
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getSandboxSettings).not.toHaveBeenCalled()
  })

  it('returns the egress mode for an authenticated user', async () => {
    mockGetCurrentUserRole.mockResolvedValue({
      authenticated: true,
      userId: 'u1',
      role: 'member',
      error: null,
    })
    getSandboxSettings.mockResolvedValue({
      presetPythonPackages: [],
      allowedIps: [],
      allowedDomains: [],
      egressMode: 'allowlist',
    })
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ egressMode: 'allowlist' })
  })
})
