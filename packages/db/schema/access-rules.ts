import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Named access rule — a reusable identity-condition tree referenced by SOP
 * visibility / data-access policies via {@link RuleRef}. One row per rule; the
 * `tree` column holds a serialized ConditionTree resolved at eval time.
 */
export const accessRules = pgTable('access_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  tree: jsonb('tree').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    // Return a Date (not sql`now()`): drizzle routes the $onUpdate value through
    // the timestamp column's mapToDriverValue (.toISOString()).
    .$onUpdate(() => new Date()),
})
