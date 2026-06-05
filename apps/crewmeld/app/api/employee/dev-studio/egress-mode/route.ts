/**
 * GET /api/employee/dev-studio/egress-mode
 *
 * Lightweight, authenticated lookup of the admin global egress mode
 * (`unrestricted` | `allowlist`). The dev-studio test panel uses it to hide
 * the per-run ephemeral allowlist input when egress is unrestricted (the input is inert
 * in that mode). Exposes only the mode — no allow-list contents — so it does
 * not require the `sandbox:view` permission that the settings page uses.
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getSandboxSettings } from '@/lib/sandbox/settings'

export async function GET(): Promise<Response> {
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const { egressMode } = await getSandboxSettings()
  return Response.json({ egressMode })
}
