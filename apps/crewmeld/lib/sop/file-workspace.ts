/**
 * SOP execution-scoped file workspace — MinIO side only.
 *
 * Storage layout (flat — no inputs/outputs subprefix split):
 *
 *   MinIO: {bucket}/sop/{sopExecutionId}/{fileName}    (30-day retention)
 *
 * The BFF never touches the PVC: it only manipulates MinIO objects. The
 * MinIO ↔ PVC sync (download conversation files on first read, upload tool
 * outputs after each call) happens inside each tool pod's server wrapper
 * — see lib/k8s/deploy-skill.ts. Tools therefore receive files in their
 * local PVC at /workspace/{execId}/, and the BFF only needs to make sure
 * MinIO has the right objects in the right prefix at the right time.
 *
 * External callers receive `https://<app>/api/sop/{execId}/files/{name}`
 * proxy URLs (constructed by the route, not stored here) — the proxy
 * streams the underlying MinIO object back without exposing the MinIO
 * endpoint or credentials.
 *
 * Lifecycle:
 *   SOP start    : copyConversationFilesToSopInputs    (MinIO CopyObject)
 *   During SOP   : tool pods do their own MinIO ↔ PVC sync
 *   SOP end      : deliverables.ts promotes LLM-referenced files into
 *                  conversations/{convId}/
 *   30 days late : workspace-cleanup-cron.ts deletes sop/{execId}/
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import { getMinioClient, MINIO_BUCKET } from '@/lib/storage/minio-client'

const logger = createLogger('SopFileWorkspace')

/** Bucket-relative prefix scoping a SOP execution's files. */
export function getSopWorkspacePrefix(sopExecutionId: string): string {
  return `sop/${sopExecutionId}/`
}

/**
 * Back-compat shims: callers that still use the old inputs/outputs split
 * end up at the flat workspace prefix. New code should call
 * getSopWorkspacePrefix directly.
 */
export function getSopInputsPrefix(sopExecutionId: string): string {
  return getSopWorkspacePrefix(sopExecutionId)
}
export function getSopOutputsPrefix(sopExecutionId: string): string {
  return getSopWorkspacePrefix(sopExecutionId)
}

/** Strip characters MinIO presigned URLs cannot round-trip safely. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_')
}

/** Lightweight MIME guess from extension, used when ListObjects results
 *  don't carry ContentType (it's only returned by GetObject / HeadObject). */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'application/octet-stream'
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export interface SopWorkspaceFile {
  /** Object key relative to the bucket, e.g. `sop/abc/foo.pdf`. */
  key: string
  /** File name as seen by the tool (last path segment). */
  name: string
  /** Bytes. */
  size: number
  /** MIME type — accurate on upload, guessed from extension on list. */
  mimeType: string
}

/** Upload a user-provided file directly into the SOP execution's MinIO prefix. */
export async function uploadSopInput(
  sopExecutionId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<SopWorkspaceFile> {
  const safe = sanitizeFileName(fileName)
  const key = `${getSopWorkspacePrefix(sopExecutionId)}${safe}`

  await getMinioClient().send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  )

  logger.info('SOP input uploaded', {
    sopExecutionId,
    key,
    size: buffer.length,
    mimeType,
  })

  return { key, name: fileName, size: buffer.length, mimeType }
}

/** List every file under the SOP execution prefix in MinIO. */
export async function listSopFiles(sopExecutionId: string): Promise<SopWorkspaceFile[]> {
  return listPrefix(getSopWorkspacePrefix(sopExecutionId))
}

/** Back-compat: same as listSopFiles. */
export async function listSopInputs(sopExecutionId: string): Promise<SopWorkspaceFile[]> {
  return listSopFiles(sopExecutionId)
}

/** Back-compat: same as listSopFiles. */
export async function listSopOutputs(sopExecutionId: string): Promise<SopWorkspaceFile[]> {
  return listSopFiles(sopExecutionId)
}

async function listPrefix(prefix: string): Promise<SopWorkspaceFile[]> {
  const client = getMinioClient()
  const results: SopWorkspaceFile[] = []
  let continuationToken: string | undefined

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )

    for (const o of list.Contents ?? []) {
      if (!o.Key || o.Key.endsWith('/')) continue
      const name = o.Key.slice(prefix.length)
      results.push({
        key: o.Key,
        name,
        size: o.Size ?? 0,
        mimeType: guessMime(name),
      })
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)

  return results
}

/**
 * Delete every object under the SOP execution's MinIO prefix. Used by the
 * 30-day cleanup cron and by explicit cancel paths.
 */
export async function deleteSopWorkspaceFromMinio(sopExecutionId: string): Promise<number> {
  const client = getMinioClient()
  const prefix = getSopWorkspacePrefix(sopExecutionId)

  let deleted = 0
  let continuationToken: string | undefined

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )

    const objects = list.Contents ?? []
    if (objects.length === 0) break

    await Promise.all(
      objects.map((o) =>
        client.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: o.Key! }))
      )
    )

    deleted += objects.length
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)

  if (deleted > 0) {
    logger.info('SOP workspace cleaned up in MinIO', { sopExecutionId, deletedCount: deleted })
  }
  return deleted
}

/** Back-compat alias for callers still using the old name. */
export const deleteSopWorkspace = deleteSopWorkspaceFromMinio

// ---------------------------------------------------------------------------
// Conversation ↔ SOP workspace bridges (MinIO ↔ MinIO only)
// ---------------------------------------------------------------------------

/** Subset of conversation file metadata needed to copy by key. */
interface ConversationFileRef {
  key: string
  name: string
  size: number
  mimeType: string
}

/** Same shape `lib/conversation/file-storage.ts` returns from uploadConversationFile. */
export interface ConversationAttachment {
  key: string
  name: string
  size: number
  mimeType: string
}

/**
 * Server-side copy a set of conversation attachments into the SOP execution's
 * MinIO prefix. Source objects in conversations/ remain untouched. The data
 * never transits through the app process — `CopyObject` runs entirely inside
 * MinIO and completes in ~10ms regardless of object size.
 *
 * The tool pod's server wrapper picks these up on first read by listing
 * sop/{execId}/ and downloading anything not yet in its PVC working dir.
 */
export async function copyConversationFilesToSopInputs(
  conversationId: string,
  files: ConversationFileRef[],
  sopExecutionId: string
): Promise<string[]> {
  if (files.length === 0) return []
  const client = getMinioClient()
  const targetPrefix = getSopWorkspacePrefix(sopExecutionId)
  const newKeys: string[] = []

  for (const f of files) {
    const baseName = f.name ? sanitizeFileName(f.name) : f.key.split('/').pop()!
    const newKey = `${targetPrefix}${baseName}`

    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: MINIO_BUCKET,
          CopySource: `${MINIO_BUCKET}/${encodeURIComponent(f.key).replace(/%2F/g, '/')}`,
          Key: newKey,
          MetadataDirective: 'COPY',
        })
      )
      newKeys.push(newKey)
    } catch (err) {
      logger.warn('Failed to copy conversation file to SOP workspace', {
        conversationId,
        sopExecutionId,
        sourceKey: f.key,
        targetKey: newKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('Copied conversation files to SOP workspace', {
    conversationId,
    sopExecutionId,
    requested: files.length,
    copied: newKeys.length,
  })
  return newKeys
}

/** Back-compat alias for the new flatter name. */
export const prepareSopWorkspace = copyConversationFilesToSopInputs

/**
 * Copy a specific set of files from sop/{execId}/ into the conversation's
 * persistent prefix. Returns the new keys so the caller can rewrite any
 * outbound URLs that referenced the SOP workspace.
 *
 * Use this from the deliverables flow — pass the filenames the LLM
 * explicitly surfaced in its final message. Files NOT in `fileNames`
 * stay only in sop/{execId}/ and are subject to the 30-day cleanup.
 */
export async function copySopFilesToConversation(
  sopExecutionId: string,
  conversationId: string,
  fileNames: string[]
): Promise<ConversationAttachment[]> {
  if (fileNames.length === 0) return []
  const client = getMinioClient()
  const sourcePrefix = getSopWorkspacePrefix(sopExecutionId)
  const attachments: ConversationAttachment[] = []

  for (const rawName of fileNames) {
    const safeName = sanitizeFileName(rawName)
    const sourceKey = `${sourcePrefix}${safeName}`
    const newKey = `conversations/${conversationId}/${Date.now()}_${safeName}`

    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: MINIO_BUCKET,
          CopySource: `${MINIO_BUCKET}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
          Key: newKey,
          MetadataDirective: 'COPY',
        })
      )
      attachments.push({
        key: newKey,
        name: rawName,
        size: 0,
        mimeType: guessMime(rawName),
      })
    } catch (err) {
      logger.warn('Failed to copy SOP file to conversation', {
        sopExecutionId,
        conversationId,
        sourceKey,
        targetKey: newKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('Copied selected SOP files to conversation', {
    sopExecutionId,
    conversationId,
    requested: fileNames.length,
    copied: attachments.length,
  })
  return attachments
}

/**
 * Back-compat shim: copy every file under sop/{execId}/ into the conversation.
 *
 * The new design surfaces only LLM-referenced deliverables (see
 * `extractDeliverableFileNames` in deliverables.ts), so this is kept for
 * callers that haven't migrated yet. New code should call
 * copySopFilesToConversation with an explicit filename list.
 */
export async function copySopOutputsToConversation(
  sopExecutionId: string,
  conversationId: string
): Promise<ConversationAttachment[]> {
  const all = await listSopFiles(sopExecutionId)
  if (all.length === 0) return []
  const names = all.map((f) => f.name)
  const attachments = await copySopFilesToConversation(sopExecutionId, conversationId, names)
  return attachments.map((a) => {
    const src = all.find((f) => f.name === a.name)
    return src ? { ...a, size: src.size, mimeType: src.mimeType } : a
  })
}
