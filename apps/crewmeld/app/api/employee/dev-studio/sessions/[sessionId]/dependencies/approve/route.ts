/**
 * POST /api/employee/dev-studio/sessions/:sessionId/dependencies/approve
 *
 * Approves the tool's current dependency set for this session. Approval is a
 * pure acknowledgement — it records the manifest's current
 * `dependencies.{libraries,domains,ips}` into `session.approvedDependencies` so
 * the "needs review" signal (manifest − approved − global-presets) clears and
 * the adopt gate releases. It does NOT rewrite the manifest: editing the actual
 * dependency list happens in the test-panel dependency editor, and globally
 * preset packages are handled automatically (never need approval).
 *
 * Since Task 8 C1 fix, the route also accepts an optional body with
 * `rejectedDomains` / `rejectedIps`. Rejected entries are accumulated into the
 * session's existing rejected sets (cumulative merge, never overwrite) so that
 * subsequent GET polls exclude them from pending, preventing false-positive
 * re-appearance of dismissed scanned entries.
 *
 * Status semantics:
 *  - 400 — invalid request body (unexpected fields)
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 409 — no manifest yet (the AI must create it before deps can be approved)
 *  - 200 — { approved } echoing the persisted manifest deps
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { readManifestFromSession } from '@/lib/dev-studio/manifest-reader'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** Zod schema for the optional POST body. Strict to reject unknown fields. */
const ApproveSchema = z
  .object({
    rejectedDomains: z.array(z.string()).optional(),
    rejectedIps: z.array(z.string()).optional(),
  })
  .strict()

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = ApproveSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid-body', detail: parsed.error.message }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const manifest = await readManifestFromSession(sessionId).catch(() => null)
  if (!manifest) {
    return new Response(
      JSON.stringify({ error: 'no-manifest', detail: 'manifest does not exist', retryable: false }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  }

  // Accumulate rejected entries from previous rounds with this round's new ones
  // and deduplicate so the set never grows unboundedly with duplicates.
  const existingRejectedDomains = session.approvedDependencies.rejectedDomains ?? []
  const existingRejectedIps = session.approvedDependencies.rejectedIps ?? []
  const incomingRejectedDomains = parsed.data.rejectedDomains ?? []
  const incomingRejectedIps = parsed.data.rejectedIps ?? []
  const mergedRejectedDomains = [...new Set([...existingRejectedDomains, ...incomingRejectedDomains])]
  const mergedRejectedIps = [...new Set([...existingRejectedIps, ...incomingRejectedIps])]

  const approvedDomains = manifest.dependencies.domains
  const approvedIps = manifest.dependencies.ips

  // A domain that is being approved this round must not linger in the rejected
  // set — the operator changed their mind and re-allowed it. Subtract approved
  // from rejected so a re-allowed host stops being suppressed.
  const rejectedDomains = mergedRejectedDomains.filter((d) => !approvedDomains.includes(d))
  const rejectedIps = mergedRejectedIps.filter((ip) => !approvedIps.includes(ip))

  const approved = {
    libraries: manifest.dependencies.libraries,
    domains: manifest.dependencies.domains,
    ips: manifest.dependencies.ips,
    rejectedDomains,
    rejectedIps,
  }
  await sessionStore.update(sessionId, { approvedDependencies: approved })
  return Response.json({ approved })
}
