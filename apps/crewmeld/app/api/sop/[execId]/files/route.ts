/**
 * GET /api/sop/[execId]/files
 *
 * List the SOP execution's output files from the NFS sop-files workspace
 * (`<volume>/sop-files/<Y>/<M>/<D>/<execId>/`) — where dev-studio /
 * opensandbox tools write their outputs.
 *
 * Authorization: capability URL, same model as the per-file route. No DB
 * lookup of SOP ownership — the execId is the bearer secret.
 *
 * Status codes:
 *   - 200 — `{ files: [{ name, size, mtime, source }] }`
 *   - 400 — invalid execId format
 *   - 500 — fatal NFS error (logged)
 */

import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { listSopFiles } from '@/lib/sop/sop-files-workspace'

const logger = createLogger('API:SopFilesList')

const EXEC_ID_RE = /^[A-Za-z0-9_-]{12,}$/

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ execId: string }> }
) {
  const { execId } = await params
  if (!EXEC_ID_RE.test(execId)) {
    return new NextResponse('Invalid execution id', { status: 400 })
  }

  try {
    const entries = await listSopFiles(execId)
    const files = entries
      .map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, source: 'nfs' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ files })
  } catch (e) {
    logger.error('NFS list failed', { execId, error: String(e) })
    return new NextResponse('Internal error', { status: 500 })
  }
}
