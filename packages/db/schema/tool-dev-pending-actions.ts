import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { toolDevSessions } from './tool-dev-sessions'

/**
 * Pending action type — Sub-spec B §4.1.
 *
 * - `choice`: User must pick from a fixed set of options.
 * - `confirm`: User must approve or reject a proposed action.
 * - `text`: User must provide a free-form text response.
 */
export type ToolDevPendingActionType = 'choice' | 'confirm' | 'text'

/**
 * Pending action lifecycle status.
 *
 * Transitions:
 *   pending -> answered (user replied)
 *   pending -> expired (timeout reached without reply)
 */
export type ToolDevPendingActionStatus = 'pending' | 'answered' | 'expired'

/**
 * Tool Dev Studio pending actions — Sub-spec B §4.1.
 *
 * Captures HITL prompts emitted by the agent that block conversation
 * progression until the user responds. `askId` is the agent-generated handle
 * used to correlate the prompt with its answer; it must be unique per session.
 */
export const toolDevPendingActions = pgTable(
  'tool_dev_pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => toolDevSessions.id, { onDelete: 'cascade' }),
    askId: text('ask_id').notNull(),
    type: text('type', { enum: ['choice', 'confirm', 'text'] })
      .$type<ToolDevPendingActionType>()
      .notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'answered', 'expired'] })
      .$type<ToolDevPendingActionStatus>()
      .notNull()
      .default('pending'),
    answer: jsonb('answer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => ({
    bySession: index('tool_dev_pending_actions_session_idx').on(t.sessionId, t.status),
    uniqueAsk: uniqueIndex('tool_dev_pending_actions_session_askid_uidx').on(
      t.sessionId,
      t.askId
    ),
  })
)
