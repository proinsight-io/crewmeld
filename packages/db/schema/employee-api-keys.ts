import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { digitalEmployees } from './employee'

export const employeeApiKeys = pgTable(
  'employee_api_keys',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id')
      .notNull()
      .references(() => digitalEmployees.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    allowedSupportUserIds: jsonb('allowed_support_user_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    hashedKey: text('hashed_key').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    employeeIdx: index('eak_employee_id_idx').on(table.employeeId),
    hashIdx: index('eak_hashed_key_idx').on(table.hashedKey),
  })
)
