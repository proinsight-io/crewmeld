import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { toolInstances } from './tool-instances'

/** Runtime state for one OpenSandbox replica of a published service. */
export const toolServiceReplicas = pgTable(
  'tool_service_replicas',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => toolInstances.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    sandboxId: text('sandbox_id'),
    endpoint: text('endpoint'),
    status: text('status').notNull().default('creating'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceIdx: index('tsr_instance_id_idx').on(table.instanceId),
    instanceOrdinalUnique: uniqueIndex('tsr_instance_ordinal_unique_idx').on(
      table.instanceId,
      table.ordinal
    ),
  })
)
