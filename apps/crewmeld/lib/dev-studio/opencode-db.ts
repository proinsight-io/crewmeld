import { existsSync } from 'node:fs'
import { createLogger } from '@crewmeld/logger'
import type { OpencodeMessageWithParts } from './opencode-rest'

const logger = createLogger('opencode-db')

/** A `message` table row: `id` is the column; `data` is JSON without an id key. */
export interface OpencodeMessageRow {
  id: string
  data: string
}

/** A `part` table row: ids live on columns; `data` is the JSON part body. */
export interface OpencodePartRow {
  id: string
  message_id: string
  session_id: string
  data: string
}

/**
 * Map raw opencode SQLite rows into the same `{ info, parts }[]` shape that the
 * REST `GET /session/:id/message` endpoint returns, so the `GET /messages`
 * route's existing `parseMessageInfo` / `parsePart` mapping is reused verbatim.
 *
 * The `id` for both messages and parts lives on the SQLite column, never inside
 * the `data` JSON, so it is merged back in here. A row whose `data` is not valid
 * JSON is skipped rather than throwing, so one corrupt row never blanks the
 * whole timeline.
 *
 * Pure function (no I/O) so it is unit-testable under Vitest's Node workers,
 * where `bun:sqlite` is unavailable.
 */
export function mapOpencodeDbRows(
  messageRows: OpencodeMessageRow[],
  partRowsByMessage: Map<string, OpencodePartRow[]>
): OpencodeMessageWithParts[] {
  const out: OpencodeMessageWithParts[] = []
  for (const m of messageRows) {
    let info: unknown
    try {
      info = { ...(JSON.parse(m.data) as Record<string, unknown>), id: m.id }
    } catch {
      logger.warn('opencode-db: skipping message row with invalid JSON', { id: m.id })
      continue
    }
    const parts: unknown[] = []
    for (const p of partRowsByMessage.get(m.id) ?? []) {
      try {
        parts.push({
          ...(JSON.parse(p.data) as Record<string, unknown>),
          id: p.id,
          messageID: p.message_id,
          sessionID: p.session_id,
        })
      } catch {
        logger.warn('opencode-db: skipping part row with invalid JSON', {
          id: p.id,
          messageID: p.message_id,
        })
      }
    }
    out.push({ info, parts })
  }
  return out
}

/**
 * Read one opencode session's full history straight from the on-disk
 * `opencode.db` (read-only), bypassing the need for a running container.
 *
 * Ordering is by `time_created` ascending — opencode's row ids are
 * reverse-chronological and inconsistent across tables, so they must NOT be
 * used to order the timeline. Returns `[]` when the file is absent or the
 * session has no messages.
 *
 * Caller contract: only invoke when the session has NO live container, so there
 * is no concurrent writer to the SQLite file.
 */
export function readOpencodeHistoryFromDisk(
  dbPath: string,
  opencodeSessionId: string
): OpencodeMessageWithParts[] {
  if (!existsSync(dbPath)) return []
  // Lazy import to avoid bundling bun:sqlite in test environments
  // @ts-expect-error bun:sqlite resolves only at Bun runtime, not in TS module resolution
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(dbPath, { readonly: true })
  try {
    const messageRows = db
      .query('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(opencodeSessionId) as OpencodeMessageRow[]
    if (messageRows.length === 0) return []
    const partRows = db
      .query(
        'SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC'
      )
      .all(opencodeSessionId) as OpencodePartRow[]
    const byMessage = new Map<string, OpencodePartRow[]>()
    for (const p of partRows) {
      const arr = byMessage.get(p.message_id)
      if (arr) arr.push(p)
      else byMessage.set(p.message_id, [p])
    }
    return mapOpencodeDbRows(messageRows, byMessage)
  } finally {
    db.close()
  }
}

/**
 * Fallback to discover the root opencode session id from the db when the
 * session row does not carry one (e.g. a fork created before the id was
 * persisted). The root session is the one with no `parent_id`; the most recent
 * is chosen when several exist.
 */
export function discoverOpencodeSessionId(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null
  // Lazy import to avoid bundling bun:sqlite in test environments
  // @ts-expect-error bun:sqlite resolves only at Bun runtime, not in TS module resolution
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .query('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 1')
      .get() as { id: string } | undefined
    return row?.id ?? null
  } finally {
    db.close()
  }
}
