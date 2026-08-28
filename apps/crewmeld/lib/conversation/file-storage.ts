/**
 * Conversation file storage.
 *
 * Files are stored on the NFS conv-io dir — the sole store of record for the
 * unified file IO contract. Nothing here touches MinIO/S3 in any direction;
 * tool-generated output files also live on NFS conv-io and are served through
 * the same key-based route.
 *
 * File key format: conversations/{conversationId}/{timestamp}_{filename}
 * Access: /api/employee/conversations/files/{key} (proxy endpoint, login auth, never expires)
 */

import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { conversations, db } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { paths } from '@/lib/dev-studio/paths'

const logger = createLogger('ConversationFileStorage')

/** File attachment metadata (stored in conversationMessages.metadata.files) */
export interface FileAttachment {
  key: string // S3 object key
  name: string // Original filename
  size: number // Bytes
  mimeType: string // MIME type
}

/** Minimal extension → MIME map for serving NFS-stored conversation files. */
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
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/** Guess a content type from a filename extension, defaulting to octet-stream. */
function guessContentType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Store an uploaded file into the conversation's NFS conv-io directory.
 *
 * NFS is the sole store of record (unified file IO contract, spec 2026-06-01):
 * the file lands in the conversation's date-layered conv-io dir — the path
 * dev-studio / opensandbox tools read at `/root/io/<sopExecId>/...` after
 * sop-bridge seeds conv-io → sop-files at SOP start.
 *
 * The caller MUST pass a real conversationId whose row already exists: the web
 * upload flow creates the conversation before uploading, and IM channels always
 * have one. There is no MinIO write / `user-` pre-conversation path — a missing
 * conversation row is a bug and throws rather than silently landing in MinIO.
 *
 * @returns FileAttachment metadata (for storing in metadata.files)
 */
export async function uploadConversationFile(
  conversationId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<FileAttachment> {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_')
  const key = `conversations/${conversationId}/${Date.now()}_${safeFileName}`
  const attachment: FileAttachment = { key, name: fileName, size: buffer.length, mimeType }

  const [convRow] = await db
    .select({ createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)

  if (!convRow) {
    throw new Error(`uploadConversationFile: conversation ${conversationId} not found`)
  }

  const dir = paths.conversationIo.forBff(conversationId, convRow.createdAt)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(nodePath.join(dir, safeFileName), buffer)
  logger.info('Conversation file stored to NFS', {
    conversationId,
    key,
    dir,
    name: safeFileName,
    size: buffer.length,
  })

  return attachment
}

/**
 * Read a conversation file from the NFS conv-io store (for the proxy endpoint).
 *
 * Only real-conversation keys shaped `conversations/<convId>/<ts>_<name>` (with
 * a non-`user-` convId) resolve to the date-layered conv-io path. Anything else
 * — old `user-` pre-conversation uploads and `chat/` context objects that used
 * to live in MinIO — is no longer served; the caller treats null as 404.
 *
 * @returns { body, contentType, contentLength } or null
 */
export async function getConversationFile(key: string): Promise<{
  body: ReadableStream | NodeJS.ReadableStream
  contentType: string
  contentLength: number
} | null> {
  const parts = key.split('/')
  if (parts[0] !== 'conversations' || !parts[1] || parts[1].startsWith('user-')) {
    return null
  }

  const convId = parts[1]
  const safeName = parts.slice(2).join('/').replace(/^\d+_/, '')
  try {
    const [convRow] = await db
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1)
    if (!convRow) return null
    const filePath = nodePath.join(paths.conversationIo.forBff(convId, convRow.createdAt), safeName)
    const stat = await fs.stat(filePath)
    return {
      body: createReadStream(filePath),
      contentType: guessContentType(safeName),
      contentLength: stat.size,
    }
  } catch (err) {
    logger.warn('Conversation file NFS read failed', { key, error: (err as Error).message })
    return null
  }
}

/** Read a conversation attachment into memory for OCR and other bounded processors. */
export async function readConversationFileBytes(
  key: string,
  maxBytes = 6 * 1024 * 1024
): Promise<Buffer | null> {
  const parts = key.split('/')
  if (parts.length !== 3 || parts[0] !== 'conversations' || !parts[1]) return null
  const convId = parts[1]
  const safeName = nodePath.basename(parts[2].replace(/^\d+_/, ''))
  try {
    const [convRow] = await db
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1)
    if (!convRow) return null
    const root = paths.conversationIo.forBff(convId, convRow.createdAt)
    const filePath = paths.safeResolve(root, safeName)
    if (!filePath) return null
    const stat = await fs.stat(filePath)
    if (stat.size > maxBytes) throw new Error(`Attachment exceeds OCR limit (${maxBytes} bytes)`)
    return await fs.readFile(filePath)
  } catch (error) {
    logger.warn('Conversation file byte read failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Delete a conversation's uploaded files from its NFS conv-io directory.
 *
 * The delete route calls this BEFORE removing the conversation row, so
 * `createdAt` is still available to locate the date-layered path. Returns the
 * number of files removed. Missing dir / row → 0.
 */
export async function deleteConversationFiles(conversationId: string): Promise<number> {
  const [convRow] = await db
    .select({ createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!convRow) return 0

  const dir = paths.conversationIo.forBff(conversationId, convRow.createdAt)
  let count: number
  try {
    count = (await fs.readdir(dir)).length
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }

  await fs.rm(dir, { recursive: true, force: true })
  if (count > 0) {
    logger.info('Conversation files cleaned up (NFS)', { conversationId, deletedCount: count })
  }
  return count
}
