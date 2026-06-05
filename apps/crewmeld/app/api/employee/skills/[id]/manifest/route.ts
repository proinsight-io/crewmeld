import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'

const logger = createLogger('SkillManifestAPI')

/**
 * GET /api/employee/skills/:id/manifest
 *
 * Returns the dev-studio manifest for a tool template, read from its NFS code
 * directory (`paths.toolCode.forBff(id)/.crewmeld-studio/manifest.json`).
 *
 * `id` is the tool template id (`tools.id`) — the source-of-truth for NFS
 * code lookup. Only dev-studio tools carry an NFS manifest; for every other
 * source the file is absent and this returns 404. The manifest is the
 * read-only metadata contract surfaced in the instance editor (kind, image,
 * libraries, domains, files, input/output schemas).
 *
 * Errors:
 *  - 401/403 unauthenticated / lacking `skill:edit`
 *  - 404 manifest absent (non-dev-studio tool or never adopted)
 *  - 422 manifest present but malformed / fails schema validation
 */
async function _GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  let manifest: Awaited<ReturnType<typeof readManifestFromTool>>
  try {
    manifest = await readManifestFromTool(id)
  } catch (err) {
    logger.warn(`Manifest read/validation failed for tool ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return apiErr('api.skill.manifestInvalid', { status: 422 })
  }

  if (!manifest) {
    return apiErr('api.skill.manifestNotFound', { status: 404 })
  }

  return apiOk({ manifest })
}

export const GET = _GET
