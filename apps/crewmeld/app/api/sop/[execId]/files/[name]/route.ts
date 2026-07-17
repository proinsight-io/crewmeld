/**
 * GET /api/sop/[execId]/files/[name]
 *
 * Proxy download for SOP workspace output files. Served from the NFS
 * sop-files workspace at `<volume>/sop-files/<Y>/<M>/<D>/<execId>/<name>` —
 * where dev-studio / opensandbox tools (kind=service deployment, kind=script
 * ephemeral) write their outputs. The sandbox mounts the sop-files root at
 * `/root/io`; tool code writes to `/root/io/<execId>/<name>`. A missing file
 * returns 404.
 *
 * Authorization model: capability URL. Anyone with the URL can download.
 * The execId is a high-entropy nanoid (12+ chars) and is therefore the
 * effective bearer secret. Do not link to these URLs from public
 * directories or search-engine-indexed pages.
 *
 * Designed for outbound consumption: links embedded in IM messages,
 * approval notifications, or email attachments — recipients do not need
 * to be logged into CrewMeld.
 */

import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { Readable as NodeReadable } from 'node:stream'
import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { paths } from '@/lib/dev-studio/paths'

const logger = createLogger('API:SopFiles')

/** Path-segment guards to keep callers from escaping the outputs/ prefix. */
const EXEC_ID_RE = /^[A-Za-z0-9_-]{12,}$/

/** Extension → MIME map for NFS-served files. MinIO carries ContentType in
 *  the object's HEAD; NFS doesn't, so this fallback table covers the
 *  common dev-studio tool outputs. */
const NFS_MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ execId: string; name: string }> }
) {
  const { execId, name: rawName } = await params
  const name = decodeURIComponent(rawName)

  if (!EXEC_ID_RE.test(execId)) {
    return new NextResponse('Invalid execution id', { status: 400 })
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return new NextResponse('Invalid file name', { status: 400 })
  }

  // Serve from the NFS sop-files workspace where dev-studio / opensandbox
  // tools write their outputs. Path-safety: the filename was already screened
  // above; paths.sopFiles.forBff itself validates the execId.
  try {
    const nfsDir = paths.sopFiles.forBff(execId)
    const nfsTarget = nodePath.join(nfsDir, name)
    const stat = await fs.stat(nfsTarget)
    if (!stat.isFile()) {
      return new NextResponse('Not found', { status: 404 })
    }
    const ext = nodePath.extname(name).toLowerCase()
    const mime = NFS_MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const stream = createReadStream(nfsTarget)
    return new NextResponse(NodeReadable.toWeb(stream) as never, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e) {
    // Missing file → clean 404; anything else is a fatal NFS error.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return new NextResponse('Not found', { status: 404 })
    }
    logger.error('SOP file NFS lookup failed', {
      execId,
      name,
      error: e instanceof Error ? e.message : String(e),
    })
    return new NextResponse('Internal error', { status: 500 })
  }
}
