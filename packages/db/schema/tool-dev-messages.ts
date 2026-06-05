import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { toolDevSessions } from './tool-dev-sessions'

/**
 * Kind of message recorded in a Tool Dev Studio session timeline.
 *
 * Mirrors the Claude Agent SDK event stream:
 * - `user`: Human message sent into the session.
 * - `assistant_text`: Plain text assistant output.
 * - `tool_use`: Assistant requested a tool invocation.
 * - `tool_result`: Tool execution result fed back to the assistant.
 * - `system`: System notice (phase change, container event, etc.).
 * - `result`: Final aggregated result of an assistant turn.
 */
export type ToolDevMessageKind =
  | 'user'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'result'

/**
 * Tool Dev Studio messages — Sub-spec B §4.1.
 *
 * Append-only event log per session. `sequence` is monotonically increasing
 * within a session and is used to drive deterministic rehydrate ordering.
 */
export const toolDevMessages = pgTable(
  'tool_dev_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => toolDevSessions.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    kind: text('kind', {
      enum: ['user', 'assistant_text', 'tool_use', 'tool_result', 'system', 'result'],
    })
      .$type<ToolDevMessageKind>()
      .notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySession: index('tool_dev_messages_session_idx').on(t.sessionId, t.sequence),
  })
)
