/**
 * PUT /api/employee/dev-studio/sessions/:sessionId/dependencies/egress
 *
 * Persists the operator-confirmed egress allow-list (external domains + IPs)
 * into the *session* manifest's `dependencies.domains/ips`. Backs the review
 * card's confirm action. Only touches the current tool's manifest — it never
 * modifies the admin global allow-list (`platform_settings.sandbox_allowed_*`).
 *
 * Server-side re-validation (defense in depth, do not trust the client):
 *  - domains must be valid FQDNs (validateManifestDomains).
 *  - ips must be valid IPv4/CIDR (validateSandboxSettings' allowedIps branch).
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 409 — no manifest yet (the AI must create it first)
 *  - 400 — bad body shape OR an invalid domain/IP
 *  - 200 — { domains, ips } echoing the persisted egress
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { setSessionManifestEgress } from '@/lib/dev-studio/manifest-reader'
import { validateManifestDomains } from '@/lib/dev-studio/network-policy-builder'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { validateSandboxSettings } from '@/lib/sandbox/settings'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const EgressSchema = z
  .object({ domains: z.array(z.string()), ips: z.array(z.string()) })
  .strict()

function badRequest(detail: string): Response {
  return new Response(
    JSON.stringify({ error: 'bad-request', detail, retryable: false }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  )
}

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = EgressSchema.safeParse(raw)
  if (!parsed.success) {
    return badRequest(parsed.error.message)
  }

  // Domains: FQDN-only (throws on the first offender).
  try {
    validateManifestDomains(parsed.data.domains)
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'invalid domain')
  }

  // IPs: reuse the sandbox settings validator's IPv4/CIDR branch.
  const ipCheck = validateSandboxSettings({ allowedIps: parsed.data.ips })
  if (!ipCheck.ok) {
    return badRequest(ipCheck.errors.allowedIps ?? 'invalid IP/CIDR')
  }

  try {
    const next = await setSessionManifestEgress(sessionId, {
      domains: parsed.data.domains,
      ips: parsed.data.ips,
    })
    return Response.json({
      domains: next.dependencies.domains,
      ips: next.dependencies.ips,
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CONFLICT')) {
      return new Response(
        JSON.stringify({ error: 'no-manifest', detail: err.message, retryable: false }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    }
    throw err
  }
}
