/**
 * GET /api/sop/[execId]/files
 *
 * List the SOP execution's output files. Combines the two backends the
 * sibling per-file route serves from:
 *   - NFS sop-files at `<volume>/sop-files/<Y>/<M>/<D>/<execId>/` —
 *     written by dev-studio tools (kind=service deploy mount + kind=script
 *     ephemeral mount, both via paths.sopFiles.forSandbox()).
 *   - MinIO `sop/<execId>/` — written by K8s tools through the rclone
 *     sidecar (legacy path).
 *
 * Entries from both backends are merged on `name`; NFS wins on collision
 * because it's where outputs land first (the rclone sidecar uploads to
 * MinIO asynchronously, so the NFS-side stat is fresher).
 *
 * Authorization: capability URL, same model as the per-file route.
 * No DB lookup of SOP ownership — the execId is the bearer secret.
 *
 * Status codes:
 *   - 200 — `{ files: [{ name, size, mtime, source }] }`
 *   - 400 — invalid execId format
 *   - 500 — fatal NFS / MinIO error (logged)
 */

import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { getSopOutputsPrefix } from '@/lib/sop/file-workspace'
import { listSopFiles } from '@/lib/sop/sop-files-workspace'
import { getMinioClient, MINIO_BUCKET } from '@/lib/storage/minio-client'

const logger = createLogger('API:SopFilesList')

const EXEC_ID_RE = /^[A-Za-z0-9_-]{12,}$/

interface ListEntry {
  name: string
  size: number
  mtime: string
  /** Which backend the entry was found in. Useful for debugging mixed SOPs. */
  source: 'nfs' | 'minio'
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ execId: string }> }
) {
  const { execId } = await params
  if (!EXEC_ID_RE.test(execId)) {
    return new NextResponse('Invalid execution id', { status: 400 })
  }

  // ── NFS side ──────────────────────────────────────────────────────────
  let nfsEntries: ListEntry[]
  try {
    const entries = await listSopFiles(execId)
    nfsEntries = entries.map((e) => ({
      name: e.name,
      size: e.size,
      mtime: e.mtime,
      source: 'nfs' as const,
    }))
  } catch (e) {
    logger.error('NFS list failed', { execId, error: String(e) })
    return new NextResponse('Internal error', { status: 500 })
  }

  // ── MinIO side ────────────────────────────────────────────────────────
  // Best-effort: a MinIO outage shouldn't blank NFS results; log and
  // continue with whatever NFS gave us.
  let minioEntries: ListEntry[] = []
  try {
    const prefix = getSopOutputsPrefix(execId)
    const res = await getMinioClient().send(
      new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: prefix })
    )
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue
      // Strip the prefix to expose the user-facing filename only.
      const name = obj.Key.slice(prefix.length)
      if (!name) continue
      minioEntries.push({
        name,
        size: obj.Size ?? 0,
        mtime: obj.LastModified?.toISOString() ?? new Date(0).toISOString(),
        source: 'minio' as const,
      })
    }
  } catch (e) {
    logger.warn('MinIO list failed, falling back to NFS-only result', {
      execId,
      error: String(e),
    })
  }

  // ── Merge: NFS wins on name collision ─────────────────────────────────
  const seen = new Set<string>(nfsEntries.map((e) => e.name))
  const merged = [...nfsEntries, ...minioEntries.filter((e) => !seen.has(e.name))]
  merged.sort((a, b) => a.name.localeCompare(b.name))

  return NextResponse.json({ files: merged })
}
