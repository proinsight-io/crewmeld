import { index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from '../schema'
import { conversations } from './conversations'
import { humanEmployees } from './human-employees'
export const humanHandoffStatusEnum = pgEnum('human_handoff_status', [
  'open',
  'assigned',
  'resolved',
])
export const humanHandoffs = pgTable(
  'human_handoffs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    assigneeId: text('assignee_id').references(() => humanEmployees.id, { onDelete: 'set null' }),
    claimedByUserId: text('claimed_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    status: humanHandoffStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdx: index('human_handoffs_conversation_idx').on(table.conversationId),
    assigneeIdx: index('human_handoffs_assignee_idx').on(table.assigneeId),
    claimedByUserIdx: index('human_handoffs_claimed_by_user_idx').on(table.claimedByUserId),
  })
)
export type HumanHandoffStatus = (typeof humanHandoffStatusEnum.enumValues)[number]
