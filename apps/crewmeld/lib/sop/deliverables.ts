/**
 * SOP deliverables processing.
 *
 * After the LLM produces a final message, this module:
 *   1. Extracts every `/api/sop/{execId}/files/{name}` URL the LLM mentioned.
 *   2. Server-side copies those specific files from MinIO sop/{execId}/...
 *      into the conversation's permanent prefix conversations/{convId}/...
 *   3. Rewrites the URLs in the message text so they point at the
 *      long-lived conversation proxy.
 *
 * Files NOT referenced in the final message stay in sop/{execId}/ and are
 * removed by the 30-day cleanup cron. This matches the design rule
 * "only LLM-surfaced files become permanent deliverables."
 *
 * SOPs that produce no files yield zero URL matches; the message is
 * returned unchanged, and no MinIO copy work happens.
 */

import { createLogger } from '@crewmeld/logger'
import {
  type ConversationAttachment,
  promoteSopFilesToConversation,
} from './sop-files-workspace'

const logger = createLogger('SopDeliverables')

/**
 * Match `/api/sop/{execId}/files/{name}` paths. The execId guard mirrors the
 * file-proxy route — at least 12 chars of nanoid-ish input — so we don't
 * mis-extract arbitrary text that happens to start with /api/sop/.
 *
 * The hostname is optional: LLMs sometimes emit absolute URLs (when
 * SOP_FILE_URL_PREFIX is set) and sometimes relative paths. Both must be
 * detected.
 *
 * The filename group accepts BALANCED parentheses so collision-renamed files
 * like `output(2).png` (see sop-files-workspace `${base}(${counter})${ext}`)
 * are captured whole. A trailing UNBALANCED `)` is left unconsumed so a
 * markdown link `[name](…/output(2).png)` stops before its closing paren
 * rather than swallowing it. The group is thus a run of ordinary filename
 * chars OR a single `(…)` group whose interior has no further parens.
 */
const SOP_FILE_URL_RE =
  /(?:https?:\/\/[^\s)>\]"']+)?\/api\/sop\/([A-Za-z0-9_-]{12,})\/files\/((?:[^\s()>\]"'`?#]|\([^\s()>\]"'`?#]*\))+)/g

export interface ExtractedReference {
  /** SOP execution id from the URL path. */
  execId: string
  /** Filename (URL-decoded). */
  fileName: string
  /** The full URL string as it appeared in the message. */
  rawUrl: string
}

/**
 * Find every SOP file URL in a message string. Same execId+fileName pair
 * is deduplicated; only the first raw URL form is kept for replacement.
 */
export function extractDeliverableFileNames(
  message: string,
  execId: string
): ExtractedReference[] {
  if (!message) return []
  const seen = new Set<string>()
  const refs: ExtractedReference[] = []

  for (const match of message.matchAll(SOP_FILE_URL_RE)) {
    const [rawUrl, matchedExecId, encodedName] = match
    if (matchedExecId !== execId) continue
    let fileName: string
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      fileName = encodedName
    }
    const dedupeKey = `${matchedExecId}::${fileName}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    refs.push({ execId: matchedExecId, fileName, rawUrl })
  }
  return refs
}

export interface ProcessDeliverablesResult {
  /** Final message with SOP URLs rewritten to conversation URLs. */
  message: string
  /** Files that were promoted to the conversation prefix. */
  attachments: ConversationAttachment[]
}

/**
 * End-to-end deliverables flow:
 *   - Extract referenced files from the message.
 *   - Promote each from the NFS sop-files workspace into the conversation's
 *     conv-io dir (where dev-studio / opensandbox tools write their outputs).
 *   - Rewrite the raw URLs in the message to point at the conversation
 *     download route (`/api/employee/conversations/files/{key}`).
 *
 * When no URLs are found, the original message is returned and no copy work
 * happens.
 *
 * `conversationCreatedAt` locates the conversation's date-layered conv-io dir;
 * when omitted (no conversation row) promotion is skipped.
 */
export async function processDeliverables(opts: {
  sopExecutionId: string
  conversationId: string
  conversationCreatedAt?: Date | string
  finalMessage: string
}): Promise<ProcessDeliverablesResult> {
  const { sopExecutionId, conversationId, conversationCreatedAt, finalMessage } = opts
  const refs = extractDeliverableFileNames(finalMessage, sopExecutionId)

  if (refs.length === 0) {
    return { message: finalMessage, attachments: [] }
  }

  const fileNames = refs.map((r) => r.fileName)

  // Promote files that dev-studio / opensandbox tools wrote to the NFS
  // sop-files workspace into the conversation's conv-io dir.
  const attachments: ConversationAttachment[] = conversationCreatedAt
    ? await promoteSopFilesToConversation(
        sopExecutionId,
        conversationId,
        conversationCreatedAt,
        fileNames
      )
    : []

  // Build a name → new key map so we can rewrite URLs in the message body.
  const nameToKey = new Map<string, string>()
  for (const a of attachments) {
    nameToKey.set(a.name, a.key)
  }

  let rewritten = finalMessage
  for (const ref of refs) {
    const newKey = nameToKey.get(ref.fileName)
    if (!newKey) continue
    const replacement = `/api/employee/conversations/files/${encodeURI(newKey)}`
    // Replace every occurrence of this exact raw URL — the LLM may have
    // mentioned the same file multiple times.
    rewritten = rewritten.split(ref.rawUrl).join(replacement)
  }

  logger.info('Processed SOP deliverables', {
    sopExecutionId,
    conversationId,
    referencedCount: refs.length,
    copiedCount: attachments.length,
  })

  return { message: rewritten, attachments }
}
