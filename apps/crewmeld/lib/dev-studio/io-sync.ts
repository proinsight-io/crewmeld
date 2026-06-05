/**
 * Seed the SOP-scoped file workspace with the operator's persistent
 * per-session test uploads.
 *
 * Unified file IO contract — same code path serves dev-studio test and
 * production SOP execution; the only thing that varies is what id plays the
 * "sopExecId" role:
 *   - **dev-studio test**: caller passes the run-test `executionId` (the
 *     test panel's execId — prefix `test_YYYYMMDD_*`). The tool's request
 *     body carries `_sopExecutionId = executionId` so the tool's
 *     `/root/io/<sopExecId>/<filename>` path resolves to the seeded dir.
 *   - **production SOP**: caller passes the SOP execution id. The
 *     `_sopExecutionId` injected by the intent-router carries the same id.
 *
 * Lifecycle (one direction only — there is no copy-back):
 *  - The operator uploads PDF/DOCX/etc. to
 *    `<bff-root>/io/session/<Y>/<M>/<D>/<sid>/` via the
 *    `/sessions/<sid>/io` route. Files persist across runs.
 *  - Right before a sandbox is created,
 *    {@link seedSopFilesFromSession} copies every flat file out of that
 *    directory into the per-sopExecId workspace
 *    (`<bff-root>/sop-files/<Y>/<M>/<D>/<sopExecId>/`).
 *  - The sandbox mounts the `<bff-root>/sop-files/` **root** at `/root/io`,
 *    so the tool reaches its inputs at
 *    `/root/io/<sopExecId>/<filename>` and writes outputs to the same dir.
 *  - The download route serves files back from the same per-sopExecId path.
 *
 * The session-io side stays untouched on every run.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { paths } from './paths'

const logger = createLogger('dev-studio:io-sync')

export interface SeedResult {
  /** Number of files copied into the sop-files dir. Zero when sessionIo is empty / absent. */
  copied: number
  /** Absolute per-sopExecId path on the BFF filesystem (where files were placed). */
  sopFilesDir: string
}

/**
 * Copy every flat file from `sessions/<sid>/io` into the per-sopExecId
 * `sop-files/<Y>/<M>/<D>/<sopExecId>/` directory.
 *
 * - Source directory missing → no-op (returns `copied: 0`); fresh sessions
 *   that never had a test upload pass through unchanged.
 * - Source is **walked one level deep**: only regular files in the root of
 *   `sessions/<sid>/io` are copied. Subdirectories are skipped on purpose to
 *   keep the `/root/io/<sopExecId>/` layout flat and predictable for tool
 *   code that does `open(f"/root/io/{sop_id}/{filename}")`.
 * - Destination directory is `mkdir -p`'d so callers don't need to pre-create.
 * - Existing files at the destination are overwritten (last-writer-wins).
 *   In the SOP scope this matters: multiple tool calls within one SOP can
 *   legitimately re-emit a file with the same name to "update" it; that's
 *   the desired chained-tools behavior.
 *
 * @returns `{ copied, sopFilesDir }` for caller logging / SSE phase emit.
 */
export async function seedSopFilesFromSession(
  sessionId: string,
  sessionCreatedAt: Date | string,
  sopExecId: string
): Promise<SeedResult> {
  const srcDir = paths.sessionIo.forBff(sessionId, sessionCreatedAt)
  const dstDir = paths.sopFiles.forBff(sopExecId)

  let entries: string[]
  try {
    entries = await fs.readdir(srcDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // Fresh session with no uploads — still mkdir the destination so the
      // sandbox mount target subdir exists when tools come looking.
      await fs.mkdir(dstDir, { recursive: true })
      return { copied: 0, sopFilesDir: dstDir }
    }
    throw e
  }

  await fs.mkdir(dstDir, { recursive: true })

  let copied = 0
  for (const name of entries) {
    const srcFile = path.join(srcDir, name)
    const stat = await fs.stat(srcFile)
    if (!stat.isFile()) continue
    const dstFile = path.join(dstDir, name)
    await fs.copyFile(srcFile, dstFile)
    copied++
  }

  logger.info({ sessionId, sopExecId, copied, srcDir, dstDir }, 'seeded sop-files from session io')

  return { copied, sopFilesDir: dstDir }
}
