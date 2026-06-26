/**
 * Workspace → tools-workspace/code atomic sync.
 *
 * Replaces the spec C packager.ts MinIO upload path. Copies a dev-studio
 * session's workspace into the tools-workspace/<toolId>/code directory on
 * NFS, using staging dir + POSIX rename for atomicity.
 *
 * Idempotency: if workspace content (sha256) matches the existing
 * .package-hash file in code/, skips the actual copy.
 *
 * Excludes: .git/, __pycache__/, node_modules/, .DS_Store, single files >5MB,
 *           total size >50MB.
 *
 * Refs spec §8.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import unzipper from 'unzipper'
import { paths } from './paths'

const logger = createLogger('code-sync')

const EXCLUDE_DIRS = new Set(['.git', '__pycache__', 'node_modules'])
const EXCLUDE_FILES = new Set(['.DS_Store'])
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_TOTAL_SIZE = 50 * 1024 * 1024 // 50MB

export interface SyncResult {
  codeDir: string
  sha256: string
  sizeBytes: number
  cached: boolean
}

interface WalkEntry {
  absPath: string
  relPath: string // posix-style (forward slash)
  size: number
}

async function walkFiles(rootDir: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  async function recurse(dir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name
      // Reject symlinks explicitly; Dirent.isDirectory()/isFile() both return false
      // for symlinks, so without this check they would be silently dropped.
      if (ent.isSymbolicLink()) {
        throw new Error(`code-sync: symlinks not supported: ${rel}`)
      }
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue
        await recurse(abs, rel)
      } else if (ent.isFile()) {
        if (EXCLUDE_FILES.has(ent.name)) continue
        const stat = await fs.stat(abs)
        if (stat.size > MAX_FILE_SIZE) {
          throw new Error(
            `code-sync: file "${rel}" (${stat.size} bytes) exceeds per-file max 5MB`,
          )
        }
        out.push({ absPath: abs, relPath: rel, size: stat.size })
      }
      // Other entry kinds (sockets, fifos, block/char devices) are silently
      // skipped — they should not appear in a normal workspace.
    }
  }
  await recurse(rootDir, '')
  return out
}

async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function hashDirectory(rootDir: string): Promise<{ sha256: string; totalSize: number; entries: WalkEntry[] }> {
  const entries = await walkFiles(rootDir)
  let totalSize = 0
  const lines: string[] = []
  for (const e of entries) {
    totalSize += e.size
  }
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new Error(`code-sync: total workspace size ${totalSize} exceeds 50MB cap`)
  }
  // Hash by sorted relPath for cross-platform reproducibility
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath))
  for (const e of entries) {
    const fileHash = await sha256OfFile(e.absPath)
    lines.push(`${e.relPath}:${fileHash}:${e.size}`)
  }
  const sha256 = crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
  return { sha256, totalSize, entries }
}

async function readPackageHash(codeDir: string): Promise<string | null> {
  try {
    const contents = await fs.readFile(path.join(codeDir, '.package-hash'), 'utf-8')
    return contents.trim()
  } catch {
    return null
  }
}

async function copyToStaging(entries: WalkEntry[], srcRoot: string, staging: string): Promise<void> {
  for (const e of entries) {
    const dst = path.join(staging, e.relPath)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(e.absPath, dst)
  }
}

function randomId(): string {
  return crypto.randomBytes(8).toString('hex')
}

async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function syncWorkspaceToCode(sessionId: string, toolId: string): Promise<SyncResult> {
  const src = paths.sessionWorkspace.forBff(sessionId)
  const dst = paths.toolCode.forBff(toolId)

  const { sha256, totalSize, entries } = await hashDirectory(src)

  // Idempotency check
  const existingHash = await readPackageHash(dst)
  if (existingHash === sha256) {
    return { codeDir: dst, sha256, sizeBytes: totalSize, cached: true }
  }

  // Stage + atomic swap
  const staging = `${dst}.staging-${randomId()}`
  await fs.mkdir(staging, { recursive: true })

  try {
    await copyToStaging(entries, src, staging)
    await fs.writeFile(path.join(staging, '.package-hash'), sha256, 'utf-8')
  } catch (err) {
    await rmrf(staging).catch(() => {})
    throw err
  }

  let backup: string | null = null
  if (await pathExists(dst)) {
    backup = `${dst}.old-${randomId()}`
    await fs.rename(dst, backup)
  }

  try {
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.rename(staging, dst)
  } catch (err) {
    // Rollback: if the backup restore also fails, the previous dst is
    // stranded under a `.old-*` path — surface that loudly so operators
    // can recover manually instead of swallowing the secondary failure.
    if (backup) {
      await fs.rename(backup, dst).catch((restoreErr) => {
        logger.warn(
          `rollback failed: rename ${backup} → ${dst} threw ${(restoreErr as Error).message}; backup directory left in place for manual recovery`,
          { backup, dst },
        )
      })
    }
    await rmrf(staging).catch(() => {})
    throw err
  }

  if (backup) {
    // Async cleanup, don't await — but log on failure so orphaned
    // `.old-*` directories on NFS don't accumulate silently.
    rmrf(backup).catch((cleanupErr) => {
      logger.warn(
        `backup cleanup failed: rmrf ${backup} threw ${(cleanupErr as Error).message}; orphaned directory left on NFS`,
        { backup },
      )
    })
  }

  return { codeDir: dst, sha256, sizeBytes: totalSize, cached: false }
}

/**
 * Import-time counterpart of {@link syncWorkspaceToCode}: extract a .cmtool
 * workspace zip into `tools-workspace/<toolId>/code/` on NFS so a deployed
 * (上架) tool finds its `start.sh` + `.crewmeld-studio/manifest.json` there.
 *
 * Adopt copies from a live session workspace; an imported package has no
 * session, so the source is the uploaded zip bytes instead. Same atomic
 * staging→rename, exclude rules, and size caps. `packageHash` is written to
 * `.package-hash` as the content fingerprint.
 */
export async function syncZipToCode(
  toolId: string,
  zipBytes: Buffer,
  packageHash: string,
): Promise<{ codeDir: string; fileCount: number; sizeBytes: number }> {
  const dst = paths.toolCode.forBff(toolId)

  const archive = await unzipper.Open.buffer(zipBytes)
  const fileEntries = archive.files.filter((f) => f.type === 'File')

  const staging = `${dst}.staging-${randomId()}`
  await fs.mkdir(staging, { recursive: true })

  let fileCount = 0
  let sizeBytes = 0
  try {
    for (const entry of fileEntries) {
      const rel = entry.path.replace(/\\/g, '/')
      const segs = rel.split('/')
      // Path-traversal / absolute-path guard — a malicious zip must not escape staging.
      if (rel.startsWith('/') || segs.includes('..')) {
        throw new Error(`syncZipToCode: unsafe entry path: ${rel}`)
      }
      if (segs.some((s) => EXCLUDE_DIRS.has(s))) continue
      if (EXCLUDE_FILES.has(segs[segs.length - 1])) continue

      const buf = await entry.buffer()
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(`syncZipToCode: file "${rel}" (${buf.length} bytes) exceeds per-file max 5MB`)
      }
      sizeBytes += buf.length
      if (sizeBytes > MAX_TOTAL_SIZE) {
        throw new Error(`syncZipToCode: total size ${sizeBytes} exceeds 50MB cap`)
      }
      const out = path.join(staging, rel)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, buf)
      fileCount++
    }
    await fs.writeFile(path.join(staging, '.package-hash'), packageHash, 'utf-8')
  } catch (err) {
    await rmrf(staging).catch(() => {})
    throw err
  }

  let backup: string | null = null
  if (await pathExists(dst)) {
    backup = `${dst}.old-${randomId()}`
    await fs.rename(dst, backup)
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.rename(staging, dst)
  } catch (err) {
    if (backup) {
      await fs.rename(backup, dst).catch((restoreErr) => {
        logger.warn(
          `rollback failed: rename ${backup} → ${dst} threw ${(restoreErr as Error).message}; backup left for manual recovery`,
          { backup, dst },
        )
      })
    }
    await rmrf(staging).catch(() => {})
    throw err
  }
  if (backup) {
    rmrf(backup).catch((cleanupErr) => {
      logger.warn(
        `backup cleanup failed: rmrf ${backup} threw ${(cleanupErr as Error).message}; orphaned dir left on NFS`,
        { backup },
      )
    })
  }

  return { codeDir: dst, fileCount, sizeBytes }
}
