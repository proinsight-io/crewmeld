/**
 * GET /api/sop/[execId]/files/[name]
 *
 * Proxy download for SOP workspace output files. Two storage backends:
 *   1. NFS sop-files at `<volume>/sop-files/<Y>/<M>/<D>/<execId>/<name>` —
 *      where dev-studio tools (kind=service deployment, kind=script
 *      ephemeral) write their outputs. The sandbox mounts the sop-files
 *      root at `/root/io`; tool code writes to `/root/io/<execId>/<name>`.
 *   2. MinIO `sop/<execId>/<name>` — legacy path used by K8s-deployed
 *      tools with the rclone-sync sidecar (lib/k8s/deploy-skill.ts). The
 *      sidecar uploads `/workspace/<execId>/` contents to MinIO after
 *      each tool call.
 *
 * The route tries NFS first (cheaper, no S3 roundtrip) and falls back to
 * MinIO on miss. Mixed SOPs (dev-studio tools + K8s tools in the same
 * execution) work transparently as long as their output filenames don't
 * collide; the caller doesn't need to know which backend wrote the file.
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
import type { Readable } from 'stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { getSopOutputsPrefix } from '@/lib/sop/file-workspace'
import { paths } from '@/lib/dev-studio/paths'
import { getMinioClient, MINIO_BUCKET } from '@/lib/storage/minio-client'

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

  // ── NFS path first ────────────────────────────────────────────────────
  // Cheaper than an S3 roundtrip on the hit case (dev-studio tools, which
  // are now the default deploy form for new tools). Path-safety: the
  // filename was already screened above; paths.sopFiles.forBff itself
  // validates the execId.
  try {
    const nfsDir = paths.sopFiles.forBff(execId)
    const nfsTarget = nodePath.join(nfsDir, name)
    const stat = await fs.stat(nfsTarget)
    if (stat.isFile()) {
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
    }
  } catch (e) {
    // ENOENT → fall through to MinIO; anything else is fatal.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('SOP file NFS lookup failed', {
        execId,
        name,
        error: e instanceof Error ? e.message : String(e),
      })
      return new NextResponse('Internal error', { status: 500 })
    }
  }

  // ── MinIO fallback (legacy K8s tools / rclone-sidecar pipeline) ──────
  const key = `${getSopOutputsPrefix(execId)}${name}`

  try {
    const obj = await getMinioClient().send(
      new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key })
    )
    if (!obj.Body) {
      return new NextResponse('Not found', { status: 404 })
    }

    const headers = new Headers({
      'Content-Type': obj.ContentType ?? 'application/octet-stream',
      // inline so browsers preview when possible (PDF, images) and fall
      // back to download otherwise. RFC 5987 encoding for non-ASCII names.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=300',
    })
    if (obj.ContentLength != null) {
      headers.set('Content-Length', String(obj.ContentLength))
    }
    if (obj.ETag) {
      headers.set('ETag', obj.ETag)
    }

    // AWS SDK v3 may return either a Web ReadableStream (modern runtimes)
    // or a Node Readable (older Node builds). Normalize to Web stream.
    const body = obj.Body
    const stream =
      body instanceof ReadableStream
        ? body
        : new ReadableStream({
            start(controller) {
              const readable = body as NodeJS.ReadableStream
              ;(readable as Readable).on('data', (chunk: Buffer) => controller.enqueue(chunk))
              ;(readable as Readable).on('end', () => controller.close())
              ;(readable as Readable).on('error', (err) => controller.error(err))
            },
          })

    return new NextResponse(stream, { status: 200, headers })
  } catch (err) {
    // MinIO/S3 surfaces missing objects as NoSuchKey or a 404 in
    // $metadata. Treat both as a clean 404 — only log unexpected errors.
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    const isNotFound =
      err instanceof Error && (err.name === 'NoSuchKey' || meta?.httpStatusCode === 404)
    if (isNotFound) {
      return new NextResponse('Not found', { status: 404 })
    }
    logger.error('SOP file proxy failed', {
      execId,
      name,
      key,
      error: err instanceof Error ? err.message : String(err),
    })
    return new NextResponse('Internal error', { status: 500 })
  }
}
