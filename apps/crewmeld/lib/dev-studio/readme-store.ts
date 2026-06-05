/**
 * Tool Dev Studio README store (Sub-spec B §4.3).
 *
 * Per-session README lives at `.crewmeld-studio/README.md`. The store enforces a
 * size cap (100 KiB) and writes through `.tmp + rename` for atomicity, so a
 * concurrent reader never observes a half-flushed file.
 *
 * Bytes — not characters — are measured against the cap, because the UI
 * eventually streams this over HTTP where the byte count is what matters.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { paths } from './paths'

/** Relative path of the README inside a session workspace. */
export const README_RELATIVE_PATH = '.crewmeld-studio/README.md' as const

/** Hard upper bound on README size, in UTF-8 bytes. */
export const README_MAX_BYTES = 100 * 1024

/**
 * Read the README for a given session. Returns `null` when the file does
 * not exist. The workspace is derived via
 * `paths.sessionWorkspace.forBff(sessionId)`.
 *
 * @throws For any non-ENOENT fs error.
 */
export async function readReadmeFromSession(sessionId: string): Promise<string | null> {
  return readReadmeFromDir(paths.sessionWorkspace.forBff(sessionId))
}

/**
 * Persist the README for a given session, creating `.crewmeld-studio/` if
 * needed. The workspace is derived via
 * `paths.sessionWorkspace.forBff(sessionId)`.
 *
 * Writes the bytes to `<file>.tmp` first and then renames into place; the
 * rename is atomic on the same filesystem (POSIX & NTFS).
 *
 * @throws When `markdown` exceeds {@link README_MAX_BYTES} UTF-8 bytes.
 */
export async function writeReadmeFromSession(
  sessionId: string,
  markdown: string
): Promise<void> {
  return writeReadmeToDir(paths.sessionWorkspace.forBff(sessionId), markdown)
}

async function readReadmeFromDir(workspaceDir: string): Promise<string | null> {
  const fp = path.join(workspaceDir, README_RELATIVE_PATH)
  try {
    return await fs.readFile(fp, 'utf-8')
  } catch (err: unknown) {
    if (isEnoent(err)) return null
    throw err
  }
}

async function writeReadmeToDir(workspaceDir: string, markdown: string): Promise<void> {
  const byteLength = Buffer.byteLength(markdown, 'utf-8')
  if (byteLength > README_MAX_BYTES) {
    throw new Error(`README exceeds ${README_MAX_BYTES} bytes (got ${byteLength})`)
  }

  const fp = path.join(workspaceDir, README_RELATIVE_PATH)
  await fs.mkdir(path.dirname(fp), { recursive: true })

  const tmp = `${fp}.tmp`
  await fs.writeFile(tmp, markdown, 'utf-8')
  try {
    await fs.rename(tmp, fp)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/** Narrow helper — Node's fs errors carry `code` on the thrown object. */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
