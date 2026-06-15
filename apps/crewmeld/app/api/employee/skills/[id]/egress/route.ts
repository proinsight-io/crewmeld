import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { setToolManifestEgress } from '@/lib/dev-studio/manifest-reader'
import { validateManifestDomains } from '@/lib/dev-studio/network-policy-builder'

const logger = createLogger('SkillEgressAPI')

const EgressSchema = z
  .object({
    domains: z.array(z.string()).default([]),
    ips: z.array(z.string()).default([]),
  })
  .strict()

/**
 * PUT /api/employee/skills/:id/egress
 *
 * Persists the per-tool egress allow-list into the tool's dev-studio manifest
 * (`dependencies.domains` + `dependencies.ips`). Edited from the instance
 * editor before listing. `id` is the tool template id (`tools.id`); the
 * allow-list is per-template, so the change applies to every instance.
 *
 * In `allowlist` egress mode these entries are unioned with the admin global
 * allow-list at deploy/invoke (see `buildToolNetworkPolicy`); in `unrestricted`
 * mode they are inert.
 *
 * Errors:
 *  - 401/403 unauthenticated / lacking `skill:edit`
 *  - 400 malformed body, or a domain that is not a bare FQDN (IPs go in `ips`)
 *  - 404 manifest absent (non-dev-studio tool or never adopted)
 */
async function _PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  const raw = await request.json().catch(() => null)
  const parsed = EgressSchema.safeParse(raw)
  if (!parsed.success) {
    return apiErr('api.skill.egressInvalid', { status: 400 })
  }

  // Domains must be bare FQDNs (the manifest-domain source is FQDN-only);
  // raw IPs/CIDRs belong in `ips`, which has no format constraint.
  try {
    validateManifestDomains(parsed.data.domains)
  } catch {
    return apiErr('api.skill.egressDomainInvalid', { status: 400 })
  }

  try {
    const next = await setToolManifestEgress(id, {
      domains: parsed.data.domains,
      ips: parsed.data.ips,
    })
    return apiOk({ domains: next.dependencies.domains, ips: next.dependencies.ips })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CONFLICT')) {
      return apiErr('api.skill.manifestNotFound', { status: 404 })
    }
    logger.error(`Failed to write egress for tool ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return apiErr('api.skill.manifestInvalid', { status: 500 })
  }
}

export const PUT = _PUT
