/**
 * tools-workspace persistent state on the shared host volume.
 *
 * Layout (derived via the paths facade):
 *   <bff-root>/tools-workspace/
 *     <toolId>/
 *       code/                  .cmtool contents (RO mounted into sandbox)
 *       .package-hash          sha256 of the .cmtool that produced code/
 *     io/<YYYY>/<MM>/<DD>/<executionId>/  per-run RW workspace
 *
 * `code/` is keyed by toolId so multiple sessions targeting the same tool
 * share the extracted code. `io/` is keyed by date + executionId so each
 * run-test invocation gets a fresh, independent IO area.
 *
 * Lazy extraction: each ensureExtracted call computes sha256 of the input
 * bytes and rewrites code/ only when the hash differs from the on-disk
 * .package-hash file (or when start.sh — the canonical "fully extracted"
 * marker — is missing).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import unzipper from 'unzipper'
import { paths } from './paths'

const HASH_FILE = '.package-hash'

export function codeDirFor(toolId: string): string {
  return paths.toolCode.forBff(toolId)
}

export function ioDirFor(executionId: string): string {
  return paths.toolIo.forBff(executionId)
}

function hashFileFor(toolId: string): string {
  // .package-hash lives alongside code/ under <toolId>/, i.e. parent of codeDir
  return path.join(path.dirname(codeDirFor(toolId)), HASH_FILE)
}

/**
 * Ensure <toolId>/code/ contains the .cmtool contents matching the supplied
 * sha256. On a mismatch (or first run), code/ is rmtree + re-extracted.
 *
 * Throws on zip entries containing path traversal sequences.
 */
export async function ensureExtracted(toolId: string, cmtoolBytes: Buffer): Promise<{ codeDir: string }> {
  const expectedHash = crypto.createHash('sha256').update(cmtoolBytes).digest('hex')
  const codeDir = codeDirFor(toolId)
  const hashFile = hashFileFor(toolId)
  const startScript = path.join(codeDir, 'start.sh')

  const onDiskHash = await readTextOrNull(hashFile)
  const startScriptExists = await pathExists(startScript)

  if (onDiskHash === expectedHash && startScriptExists) {
    return { codeDir }
  }

  // Need to (re-)extract
  await fs.rm(codeDir, { recursive: true, force: true })
  await fs.mkdir(codeDir, { recursive: true })

  const directory = await unzipper.Open.buffer(cmtoolBytes)
  for (const entry of directory.files) {
    if (entry.path.includes('..')) {
      throw new Error(`path traversal detected in zip entry: ${entry.path}`)
    }
    const dest = path.join(codeDir, entry.path)
    if (!dest.startsWith(codeDir + path.sep) && dest !== codeDir) {
      throw new Error(`path traversal detected in zip entry: ${entry.path}`)
    }
    if (entry.type === 'Directory') {
      await fs.mkdir(dest, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, await entry.buffer())
  }
  await fs.writeFile(hashFile, expectedHash, 'utf-8')

  return { codeDir }
}

/** mkdir -p <root>/tools-workspace/io/<YYYY>/<MM>/<DD>/<executionId>/ and return the absolute path. */
export async function ensureIoDir(executionId: string): Promise<string> {
  const dir = ioDirFor(executionId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function readTextOrNull(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, 'utf-8')).trim()
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'ENOENT') return null
    throw e
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
