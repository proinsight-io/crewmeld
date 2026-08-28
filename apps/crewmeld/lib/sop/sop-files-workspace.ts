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
 * This NFS workspace is now the sole seed path for SOP tool inputs; the old
 * MinIO seed (file-workspace) was removed once all tools moved to NFS.
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
 *
 * Called lazily — only from the two points that genuinely need the dir:
 *   - {@link seedFromConversationIoToSopFiles} when it has ≥1 input file to copy;
 *   - `materializeMountedTools` when the node has a `needsFileMount` tool that
 *     may write outputs (covers every trigger type, not just conversations).
 * A file-free SOP hits neither, so it never allocates an empty per-execution
 * dir. The log stays at debug so a file SOP produces one quiet line, not the
 * two info lines the old unconditional-plus-seed double call emitted.
 */
export async function allocateSopFiles(sopExecId: string): Promise<string> {
  const dir = paths.sopFiles.forBff(sopExecId)
  await fs.mkdir(dir, { recursive: true })
  logger.debug('allocated sop-files dir', { sopExecId, dir })
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
 * - Source missing or empty (fresh conversation with no uploads) → no-op,
 *   `copied: 0`, and the destination dir is NOT created. A tool that only
 *   produces outputs gets its dir from `materializeMountedTools` instead, so
 *   a file-free SOP leaves no empty dir behind.
 * - One level deep — only regular files at the root of conv-io are seeded;
 *   subdirs ignored to keep `/root/io/<sopExecId>/...` flat.
 * - Destination collisions overwrite (last-writer-wins). Within one SOP
 *   that's the desired "tool A re-emits a file" behavior.
 *
 * `names` restricts the seed to the caller-supplied file names — the ones the
 * user pointed at in their request (relayed verbatim by the LLM as
 * `input_files`). Matching is done against the sanitized on-disk name so a
 * name like `月 报.xlsx` still resolves to the stored `月_报.xlsx`. When
 * `names` is omitted every root file is seeded (legacy whole-conversation
 * behavior). An empty array seeds nothing.
 *
 * The conv-io side stays untouched on every run.
 */
export async function seedFromConversationIoToSopFiles(
  convId: string,
  convCreatedAt: Date | string,
  sopExecId: string,
  names?: string[]
): Promise<{ copied: number; sopFilesDir: string }> {
  const srcDir = paths.conversationIo.forBff(convId, convCreatedAt)
  // Compute the destination path but do NOT create it yet — a seed that copies
  // nothing must not leave an empty dir behind (lazy-create on first copy).
  const dstDir = paths.sopFiles.forBff(sopExecId)

  // When a name list is given, match against the same sanitization the upload
  // path applies before writing to disk (file-storage.uploadConversationFile).
  const wanted = names
    ? new Set(names.map((n) => n.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_')))
    : null

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
    if (wanted && !wanted.has(name)) continue
    const srcFile = path.join(srcDir, name)
    const stat = await fs.stat(srcFile)
    if (!stat.isFile()) continue
    // Allocate the dir only when there is a real file to place in it.
    if (copied === 0) await allocateSopFiles(sopExecId)
    const dstFile = path.join(dstDir, name)
    await fs.copyFile(srcFile, dstFile)
    copied++
  }

  logger.info('seeded sop-files from conversation io', {
    convId,
    sopExecId,
    copied,
    srcDir,
    dstDir,
  })

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
  logger.info('deleted sop-files dir', { sopExecId, dir })
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
  return resolveUniqueNameIn(paths.sopFiles.forBff(sopExecId), candidateName)
}

/**
 * Directory-scoped variant of {@link resolveUniqueName}: pick a name that does
 * not collide with an existing file in `dir`, suffixing `name(2).ext`,
 * `name(3).ext`, … Used both for the SOP workspace (via resolveUniqueName) and
 * for the conversation dir when promoting deliverables, so two same-named
 * outputs never clobber each other on disk.
 */
async function resolveUniqueNameIn(dir: string, candidateName: string): Promise<string> {
  const ext = path.extname(candidateName)
  const base = ext ? candidateName.slice(0, -ext.length) : candidateName

  // First try the original name.
  let attempt = candidateName
  let counter = 2
  // Cap at a sensible ceiling so a runaway loop on a stuck FS can't hang
  // the tool call. 1000 collisions in one dir is already pathological.
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

/** Minimal extension → MIME map for promoted deliverables. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream'
}

/** A deliverable file promoted from the SOP workspace into the conversation. */
export interface ConversationAttachment {
  /**
   * Conversation-scoped key: `conversations/<convId>/<ts>_<onDiskName>`. Shaped
   * so `getConversationFile` strips the `<ts>_` prefix and reads the file back
   * from the conv-io NFS dir.
   */
  key: string
  /** Original (display) filename as surfaced by the LLM. */
  name: string
  /** Bytes. */
  size: number
  /** MIME guessed from the extension. */
  mimeType: string
}

/**
 * Promote specific SOP output files from the NFS sop-files workspace into the
 * conversation's persistent conv-io directory, so LLM-surfaced deliverables
 * survive the 30-day SOP-workspace cleanup and get a stable, conversation-
 * scoped download URL.
 *
 * dev-studio / opensandbox tools write outputs to NFS, so this is the sole
 * deliverables promotion path; a file NOT found on NFS is skipped (its URL is
 * simply left un-rewritten in the message).
 *
 * The on-disk destination name is de-duplicated against the conv-io dir so two
 * deliverables named `output(2).png` (from two separate SOP executions in the
 * same conversation) land as `output(2).png` and `output(2)(2).png` rather than
 * clobbering each other — the conv-io read path is name-addressed, not
 * timestamp-addressed.
 */
export async function promoteSopFilesToConversation(
  sopExecId: string,
  convId: string,
  convCreatedAt: Date | string,
  fileNames: string[]
): Promise<ConversationAttachment[]> {
  if (fileNames.length === 0) return []
  const srcDir = paths.sopFiles.forBff(sopExecId)
  const dstDir = paths.conversationIo.forBff(convId, convCreatedAt)
  const out: ConversationAttachment[] = []

  for (const rawName of fileNames) {
    // The name came from LLM message text; reject path escapes defensively.
    if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) continue

    const srcFile = path.join(srcDir, rawName)
    let size: number
    try {
      const stat = await fs.stat(srcFile)
      if (!stat.isFile()) continue
      size = stat.size
    } catch (e) {
      // A missing NFS output was not materialized in the shared workspace.
      // Skip it and leave the original file reference unchanged.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }

    await fs.mkdir(dstDir, { recursive: true })
    const uniqueName = await resolveUniqueNameIn(dstDir, rawName)
    await fs.copyFile(srcFile, path.join(dstDir, uniqueName))
    out.push({
      key: `conversations/${convId}/${Date.now()}_${uniqueName}`,
      name: rawName,
      size,
      mimeType: guessMime(rawName),
    })
  }

  logger.info('promoted sop-files to conversation', {
    sopExecId,
    convId,
    requested: fileNames.length,
    copied: out.length,
  })
  return out
}
