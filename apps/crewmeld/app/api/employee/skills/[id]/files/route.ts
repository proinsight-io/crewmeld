import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { buildFileTreeFromTool, type FileNode } from '@/lib/dev-studio/file-tree'

const logger = createLogger('SkillFilesAPI')

const EMPTY_TREE: FileNode = { name: '', path: '', type: 'directory', children: [] }

/**
 * GET /api/employee/skills/:id/files
 *
 * Returns a recursive `FileNode` snapshot of a dev-studio tool's persistent
 * code directory (`paths.toolCode.forBff(id)`), read directly off the
 * BFF-accessible NFS volume. `.crewmeld-studio` / `.git` are filtered so
 * AI bookkeeping never leaks to the operator code browser.
 *
 * `id` is the tool template id. Tools without an NFS code directory (never
 * adopted, or non-dev-studio) yield an empty tree so the browser renders its
 * empty affordance rather than an error.
 */
async function _GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const { id } = await params

  try {
    const tree = await buildFileTreeFromTool(id)
    return apiOk({ tree })
  } catch (err: unknown) {
    // Missing code directory → empty tree (not an error for the operator).
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') {
      return apiOk({ tree: EMPTY_TREE })
    }
    logger.warn(`Failed to build file tree for tool ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return apiErr('api.skill.filesReadFailed', { status: 502 })
  }
}

export const GET = _GET
