/**
 * Workspace -> .cmtool zip packaging primitives.
 *
 * Pure utilities for building a workspace zip + sha256, plus MinIO bucket
 * constants used by the legacy skills import/export/test-run routes that
 * still source `.cmtool` packages from MinIO.
 *
 * As of spec 2026-05-28-cross-platform-nfs-volume-design.md the dev-studio
 * run-test / adopt path uses {@link syncWorkspaceToCode} (NFS-backed) instead
 * of the previous package-upload-download-extract chain, so this module no
 * longer exports `packageWorkspace` and no longer writes
 * `tool_dev_sessions.lastPackage`. The remaining exports are still consumed
 * by routes under `app/api/employee/skills/**` that have not yet migrated
 * off MinIO storage for `.cmtool` template packages.
 *
 * Exclusion rules:
 *   - .git/, node_modules/, __pycache__/, .next/, dist/, .DS_Store, Thumbs.db
 *   - Any single file larger than MAX_SINGLE_FILE_BYTES (5 MiB) is skipped
 *     individually but does not abort the whole package.
 *   - Total uncompressed footprint > MAX_ZIP_SIZE_BYTES (50 MiB) aborts with
 *     a typed error — workspaces this large are almost certainly polluted
 *     by accidental large files; the user should clean up.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import archiver from 'archiver'
import { getMinioClient } from '@/lib/storage/minio-client'

const logger = createLogger('DevStudioPackager')

/** Maximum total uncompressed workspace footprint allowed (50 MiB). */
export const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024
/** Maximum size of any single file inside the workspace (5 MiB). */
export const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024

/** MinIO bucket dedicated to packaged .cmtool zips. */
export const TOOL_PACKAGES_BUCKET = 'tool-packages'

const EXCLUDE_DIR_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.next', 'dist'])
const EXCLUDE_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

/** Enumerated reasons a path was skipped during packaging. */
export const ExcludeReason = {
  DirExcluded: 'dir-excluded',
  FileExcluded: 'file-excluded',
  SingleFileTooLarge: 'single-file-too-large',
} as const
export type ExcludeReasonT = (typeof ExcludeReason)[keyof typeof ExcludeReason]

/** Result of {@link buildZipForWorkspace} — zip bytes plus diagnostics. */
export interface BuildZipResult {
  zipBytes: Buffer
  included: string[]
  excluded: Array<{ path: string; reason: ExcludeReasonT }>
}

/** Compute hex sha256 of a buffer. */
export function computeShaForBytes(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Walk a workspace directory and produce a zip Buffer + included/excluded
 * lists. No DB or MinIO side effects — exposed for unit testing in isolation.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @throws When total uncompressed footprint exceeds {@link MAX_ZIP_SIZE_BYTES}.
 */
export async function buildZipForWorkspace(workspaceDir: string): Promise<BuildZipResult> {
  const included: string[] = []
  const excluded: Array<{ path: string; reason: ExcludeReasonT }> = []

  // First pass: walk to compute total size + decide exclusions.
  const filesToInclude: Array<{ abs: string; rel: string; size: number }> = []
  await walk(workspaceDir, '', filesToInclude, excluded)

  let totalSize = 0
  for (const f of filesToInclude) totalSize += f.size
  if (totalSize > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `Workspace size (${totalSize} bytes) exceeds limit (${MAX_ZIP_SIZE_BYTES} bytes); ` +
        `please clean up large files.`
    )
  }

  // Second pass: stream into archiver, collecting bytes into a buffer.
  const archive = archiver('zip', { zlib: { level: 6 } })
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk: Buffer) => chunks.push(chunk))
  const sinkDone = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve)
    sink.on('error', reject)
    archive.on('error', reject)
  })

  archive.pipe(sink)
  for (const f of filesToInclude) {
    archive.file(f.abs, { name: f.rel })
    included.push(f.rel)
  }
  await archive.finalize()
  await sinkDone

  return { zipBytes: Buffer.concat(chunks), included, excluded }
}

/**
 * Recursive workspace walker. Forward slashes are used for relative paths so
 * the resulting zip entries are portable across platforms.
 */
async function walk(
  base: string,
  rel: string,
  out: Array<{ abs: string; rel: string; size: number }>,
  excluded: Array<{ path: string; reason: ExcludeReasonT }>
): Promise<void> {
  const abs = rel ? path.join(base, rel) : base
  const entries = await fs.readdir(abs, { withFileTypes: true })
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(ent.name)) {
        excluded.push({ path: childRel, reason: ExcludeReason.DirExcluded })
        continue
      }
      await walk(base, childRel, out, excluded)
    } else if (ent.isFile()) {
      if (EXCLUDE_FILE_NAMES.has(ent.name)) {
        excluded.push({ path: childRel, reason: ExcludeReason.FileExcluded })
        continue
      }
      const absChild = path.join(base, childRel)
      const stat = await fs.stat(absChild)
      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        excluded.push({
          path: childRel,
          reason: ExcludeReason.SingleFileTooLarge,
        })
        continue
      }
      out.push({ abs: absChild, rel: childRel, size: stat.size })
    }
    // Sockets, FIFOs, symlinks, etc. are intentionally ignored.
  }
}

/**
 * Ensure the {@link TOOL_PACKAGES_BUCKET} MinIO bucket exists, creating it on
 * first use. MinIO's `mc mb --ignore-existing` is run only for the default
 * `tool-files` bucket at compose startup; this bucket is created lazily on
 * the first packaging request.
 */
export async function ensureToolPackagesBucket(): Promise<void> {
  const client = getMinioClient()
  try {
    await client.send(new HeadBucketCommand({ Bucket: TOOL_PACKAGES_BUCKET }))
    return
  } catch {
    // Fall through to create.
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: TOOL_PACKAGES_BUCKET }))
    logger.info('Created MinIO bucket', { bucket: TOOL_PACKAGES_BUCKET })
  } catch (err) {
    // Race: another process may have created it between Head and Create.
    const code = (err as { name?: string }).name
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw err
    }
  }
}
