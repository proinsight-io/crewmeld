/**
 * SOP-scoped file workspace on NFS — the storage side of the unified file IO
 * contract that dev-studio tools read at `/root/io/<sopExecId>/<filename>`.
 *
 * Layout: `<bff-root>/sop-files/<Y>/<M>/<D>/<sopExecId>/<filename>` —
 * mirrors {@link paths.sopFiles.forBff}. The sandbox mounts the **root**
 * (`<volume>/sop-files/`) at `/root/io`; the per-sopExecId subdir is
 * navigated in tool code via the `_sopExecutionId` injected by
 * intent-router / sandbox-loader / script-invoker.
 *
 * Lifecycle (mirrors dev-studio test mode session-io → sop-files):
 *   - SOP start          → {@link allocateSopFiles} mkdirs the subdir
 *                          (idempotent), then
 *                          {@link seedFromConversationIoToSopFiles} copies
 *                          NFS conv-io files into it.
 *   - During SOP         → tool pods read/write files directly (NFS mount).
 *   - SOP end / cleanup  → {@link deleteSopFiles} removes the subdir.
 *
 * The legacy MinIO seed
 * ({@link copyConversationFilesToSopInputs}) still runs in parallel for
 * K8s tools with rclone sidecars — both paths carry the same bytes for
 * different consumers.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { paths } from '@/lib/dev-studio/paths'

const logger = createLogger('SopFilesWorkspace')

/** A flat-file entry in the SOP NFS workspace. */
export interface SopFileEntry {
  name: string
  size: number
  mtime: string
}

/**
 * Ensure `<bff-root>/sop-files/<Y>/<M>/<D>/<sopExecId>/` exists. Idempotent.
 * Called at SOP start before any tool invocation so the sandbox mount root's
 * per-SOP subdir is present even when no conversation files exist (tools may
 * still write outputs into it).
 */
export async function allocateSopFiles(sopExecId: string): Promise<string> {
  const dir = paths.sopFiles.forBff(sopExecId)
  await fs.mkdir(dir, { recursive: true })
  logger.info({ sopExecId, dir }, 'allocated sop-files dir')
  return dir
}

/**
 * Copy every flat file from the conversation's NFS staging dir
 * (`<volume>/io/conversation/<Y>/<M>/<D>/<convId>/`) into the per-sopExecId
 * `<volume>/sop-files/<Y>/<M>/<D>/<sopExecId>/` directory.
 *
 * Direction is conv-io → sop-files (NFS → NFS, no MinIO involvement) —
 * symmetric to the dev-studio test flow's session-io → sop-files seed in
 * `lib/dev-studio/io-sync.ts`.
 *
 * - Source missing (fresh conversation with no uploads) → no-op,
 *   `copied: 0`. Destination is still mkdir'd so tools that only produce
 *   outputs have a place to write.
 * - One level deep — only regular files at the root of conv-io are seeded;
 *   subdirs ignored to keep `/root/io/<sopExecId>/...` flat.
 * - Destination collisions overwrite (last-writer-wins). Within one SOP
 *   that's the desired "tool A re-emits a file" behavior.
 *
 * The conv-io side stays untouched on every run.
 */
export async function seedFromConversationIoToSopFiles(
  convId: string,
  convCreatedAt: Date | string,
  sopExecId: string
): Promise<{ copied: number; sopFilesDir: string }> {
  const srcDir = paths.conversationIo.forBff(convId, convCreatedAt)
  const dstDir = await allocateSopFiles(sopExecId)

  let entries: string[]
  try {
    entries = await fs.readdir(srcDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { copied: 0, sopFilesDir: dstDir }
    }
    throw e
  }

  let copied = 0
  for (const name of entries) {
    const srcFile = path.join(srcDir, name)
    const stat = await fs.stat(srcFile)
    if (!stat.isFile()) continue
    const dstFile = path.join(dstDir, name)
    await fs.copyFile(srcFile, dstFile)
    copied++
  }

  logger.info(
    { convId, sopExecId, copied, srcDir, dstDir },
    'seeded sop-files from conversation io'
  )

  return { copied, sopFilesDir: dstDir }
}

/** List flat files in the SOP NFS workspace. Missing dir → empty array. */
export async function listSopFiles(sopExecId: string): Promise<SopFileEntry[]> {
  const dir = paths.sopFiles.forBff(sopExecId)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const files: SopFileEntry[] = []
  for (const name of entries) {
    const stat = await fs.stat(path.join(dir, name))
    if (stat.isFile()) {
      files.push({ name, size: stat.size, mtime: stat.mtime.toISOString() })
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

/**
 * Tear down `sop-files/<Y>/<M>/<D>/<sopExecId>/`. Called from SOP-end hooks
 * or the cleanup cron. Idempotent — missing dir is silent success.
 */
export async function deleteSopFiles(sopExecId: string): Promise<void> {
  const dir = paths.sopFiles.forBff(sopExecId)
  await fs.rm(dir, { recursive: true, force: true })
  logger.info({ sopExecId, dir }, 'deleted sop-files dir')
}

/**
 * Pick a filename inside the SOP's sop-files dir that does not collide with
 * an existing file. Mirrors the OS file-manager convention: `report.pdf`,
 * then `report(2).pdf`, `report(3).pdf`, …
 *
 * Same-SOP tool collisions land here:
 *   - Two tools both write `result.png` — the second invocation gets
 *     `result(2).png` so the LLM's `download_url` still points at the
 *     right artefact.
 *   - One tool retried in the same SOP and reuses its own filename —
 *     same treatment.
 *
 * Callers should:
 *   1. Compute the candidate name from the tool's `output_file`.
 *   2. Call this helper to get the final (possibly suffixed) name.
 *   3. If different, rename the on-disk file before surfacing the result.
 *
 * Race notes: the check-then-rename pattern is not atomic. Within one SOP
 * tool calls are serialised by the LLM agent loop (one tool at a time), so
 * concurrent writes from the same SOP shouldn't happen. Cross-SOP can't
 * collide — each SOP has its own subdir.
 */
export async function resolveUniqueName(
  sopExecId: string,
  candidateName: string
): Promise<string> {
  const dir = paths.sopFiles.forBff(sopExecId)
  const ext = path.extname(candidateName)
  const base = ext ? candidateName.slice(0, -ext.length) : candidateName

  // First try the original name.
  let attempt = candidateName
  let counter = 2
  // Cap at a sensible ceiling so a runaway loop on a stuck FS can't hang
  // the tool call. 1000 collisions in one SOP is already pathological.
  const MAX_ATTEMPTS = 1000
  while (counter <= MAX_ATTEMPTS + 1) {
    try {
      await fs.access(path.join(dir, attempt))
      // Exists → try next suffix.
      attempt = `${base}(${counter})${ext}`
      counter++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return attempt
      }
      throw e
    }
  }
  // Pathological case — never expected in practice.
  throw new Error(
    `resolveUniqueName: exhausted ${MAX_ATTEMPTS} attempts for ${candidateName} in ${dir}`
  )
}
