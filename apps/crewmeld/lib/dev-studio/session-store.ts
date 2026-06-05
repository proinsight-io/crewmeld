/**
 * DB-backed session store for Tool Dev Studio (Sub-spec B §4.1, §5).
 *
 * Replaces the in-process {@link SessionRegistry} from sub-spec A with a
 * Postgres-backed CRUD layer. Two in-memory satellites stay co-located here
 * because they only matter while the BFF process is alive:
 *
 * - `streamingSessions`: which sessionIds currently have an open SSE stream,
 *   used by route handlers to reject concurrent `/chat` requests.
 * - `systemNoteQueue`: out-of-band notes (e.g. "container expired, please
 *   restart") that should be flushed into the next response stream.
 *
 * Both satellites are best-effort and recover on process restart.
 */
import { db, toolDevMessages, toolDevSessions } from '@crewmeld/db'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import { and, desc, eq, ilike, sql } from 'drizzle-orm'

export type SessionRecord = InferSelectModel<typeof toolDevSessions>
export type NewSession = InferInsertModel<typeof toolDevSessions>

export type SessionStatus = 'active' | 'adopted' | 'archived'

export interface ListOptions {
  /** Filter by lifecycle status. Defaults to 'active'. Pass 'all' for all statuses. */
  status?: SessionStatus | 'all'
  /** Case-insensitive substring match against title. */
  q?: string
  /** Filter sessions linked to a specific tool. Pass 'none' for sessions with no tool (new-tool stage). */
  toolId?: string | 'none'
}

const streamingSessions = new Set<string>()
const systemNoteQueue = new Map<string, string[]>()

/** Per-session queue of user-uploaded reference files awaiting in-band
 *  announcement to the AI on the operator's next chat turn. */
export interface UploadNotice {
  filename: string
  size: number
}
const uploadNoticeQueue = new Map<string, UploadNotice[]>()

/**
 * Singleton store for `tool_dev_sessions` rows + in-process streaming state.
 *
 * @remarks
 * Importers should treat this as a service object: do not instantiate.
 * The DB layer (`db`) is configured at module load time via `@crewmeld/db`.
 */
export const sessionStore = {
  /**
   * List sessions owned by `userId`, newest-active first.
   *
   * @param userId - Owner of the sessions (better-auth text id).
   * @param opts.status - Defaults to `'active'`. Pass `'archived'` etc. to widen.
   * @param opts.q - Case-insensitive substring match against `title`.
   */
  async list(userId: string, opts?: ListOptions): Promise<SessionRecord[]> {
    const conditions = [eq(toolDevSessions.userId, userId)]

    const status = opts?.status ?? 'active'
    if (status !== 'all') {
      conditions.push(eq(toolDevSessions.status, status))
    }

    if (opts?.q) {
      conditions.push(ilike(toolDevSessions.title, `%${opts.q}%`))
    }

    if (opts?.toolId === 'none') {
      conditions.push(sql`${toolDevSessions.toolId} IS NULL`)
    } else if (opts?.toolId) {
      conditions.push(eq(toolDevSessions.toolId, opts.toolId))
    }

    return db
      .select()
      .from(toolDevSessions)
      .where(and(...conditions))
      .orderBy(desc(toolDevSessions.lastActiveAt))
  },

  /**
   * Fetch a single session by id. Returns `null` when not found.
   */
  async get(sessionId: string): Promise<SessionRecord | null> {
    const rows = await db
      .select()
      .from(toolDevSessions)
      .where(eq(toolDevSessions.id, sessionId))
      .limit(1)
    return rows[0] ?? null
  },

  /**
   * Create a new session row. Server defaults supply timestamps/status; `id`
   * may be passed explicitly when the caller needs the row, host paths and
   * bind-mount labels to share one UUID (see POST /sessions). When omitted,
   * the DB's `defaultRandom()` provides one.
   */
  async create(
    input: Omit<NewSession, 'createdAt' | 'updatedAt' | 'lastActiveAt'>
  ): Promise<SessionRecord> {
    const rows = await db.insert(toolDevSessions).values(input).returning()
    return rows[0]
  },

  /**
   * Patch arbitrary columns. Always refreshes `updatedAt` to `new Date()`.
   */
  async update(sessionId: string, patch: Partial<NewSession>): Promise<SessionRecord> {
    const rows = await db
      .update(toolDevSessions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(toolDevSessions.id, sessionId))
      .returning()
    return rows[0]
  },

  /**
   * Move a session to `archived` and tear down any container metadata.
   */
  async archive(sessionId: string): Promise<void> {
    await db
      .update(toolDevSessions)
      .set({
        status: 'archived',
        containerStatus: 'destroyed',
        activeContainerId: null,
        updatedAt: new Date(),
      })
      .where(eq(toolDevSessions.id, sessionId))
  },

  /**
   * Suspend a session: tear down its container metadata but keep the row
   * `active` so it stays resumable.
   *
   * Unlike {@link archive} this preserves the session lifecycle — the operator
   * navigated away (implicit background) rather than explicitly discarding, so
   * the workspace and history are kept and a later rehydrate re-spins a
   * container on the same host directories. Only `containerStatus` /
   * `activeContainerId` change; `status` is deliberately left untouched.
   */
  async suspend(sessionId: string): Promise<void> {
    await db
      .update(toolDevSessions)
      .set({
        containerStatus: 'destroyed',
        activeContainerId: null,
        updatedAt: new Date(),
      })
      .where(eq(toolDevSessions.id, sessionId))
  },

  /**
   * Whether the session carries at least one operator (`user`) message.
   *
   * Used to tell an abandoned empty session (safe to purge when the operator
   * backgrounds it) apart from one holding real in-progress work (must be
   * preserved).
   */
  async hasUserMessages(sessionId: string): Promise<boolean> {
    const rows = await db
      .select({ id: toolDevMessages.id })
      .from(toolDevMessages)
      .where(and(eq(toolDevMessages.sessionId, sessionId), eq(toolDevMessages.kind, 'user')))
      .limit(1)
    return rows.length > 0
  },

  /**
   * Promote a session to `adopted` (a real Tool was created from it).
   * Container is torn down; `adoptedAt` is stamped to `new Date()`.
   */
  async adopt(sessionId: string, toolId?: string): Promise<void> {
    const now = new Date()
    await db
      .update(toolDevSessions)
      .set({
        status: 'adopted',
        adoptedAt: now,
        ...(toolId != null ? { toolId } : {}),
        containerStatus: 'destroyed',
        activeContainerId: null,
        updatedAt: now,
      })
      .where(eq(toolDevSessions.id, sessionId))
  },

  /**
   * Update the last-message preview snippet for a session.
   * Truncates `text` to 60 characters before storing.
   *
   * @param sessionId - Target session.
   * @param text - Raw message text to preview.
   */
  async updateLastMessagePreview(sessionId: string, text: string): Promise<void> {
    const preview = text.slice(0, 60)
    await db
      .update(toolDevSessions)
      .set({ lastMessagePreview: preview, updatedAt: new Date() })
      .where(eq(toolDevSessions.id, sessionId))
  },

  /**
   * Whether a session currently has an open SSE stream from this BFF process.
   */
  hasActiveStreaming(sessionId: string): boolean {
    return streamingSessions.has(sessionId)
  },

  /**
   * Toggle the in-process streaming flag for a session.
   */
  markStreaming(sessionId: string, streaming: boolean): void {
    if (streaming) streamingSessions.add(sessionId)
    else streamingSessions.delete(sessionId)
  },

  /**
   * Queue an out-of-band system note to be flushed on the next stream.
   */
  queueSystemNote(sessionId: string, note: string): void {
    const arr = systemNoteQueue.get(sessionId) ?? []
    arr.push(note)
    systemNoteQueue.set(sessionId, arr)
  },

  /**
   * Drain (consume) all queued system notes for a session.
   *
   * @returns The queued notes in insertion order; subsequent calls return `[]`.
   */
  drainSystemNotes(sessionId: string): string[] {
    const arr = systemNoteQueue.get(sessionId) ?? []
    systemNoteQueue.delete(sessionId)
    return arr
  },

  /**
   * Queue an uploaded reference file for in-band announcement on the next
   * chat turn. Separate from `systemNoteQueue` so the chat route can render a
   * dedicated envelope describing the file purpose ("read these as inputs
   * for the tool you are building") rather than the ask-answer envelope.
   */
  queueUploadNotice(sessionId: string, notice: UploadNotice): void {
    const arr = uploadNoticeQueue.get(sessionId) ?? []
    arr.push(notice)
    uploadNoticeQueue.set(sessionId, arr)
  },

  /**
   * Drain (consume) all queued upload notices for a session.
   *
   * @returns Notices in insertion order; subsequent calls return `[]`.
   */
  drainUploadNotices(sessionId: string): UploadNotice[] {
    const arr = uploadNoticeQueue.get(sessionId) ?? []
    uploadNoticeQueue.delete(sessionId)
    return arr
  },
}
