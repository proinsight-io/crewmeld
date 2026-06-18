import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * [IDENTITY-FIELD-MAP · MERGE→dev0.0.1] Global channel→normalized identity field map.
 *
 * One row per normalized field (e.g. employeeNo). `paths` maps channelType →
 * { kind:'path', path } | { kind:'const', value }. Empty table ⇒ runtime falls
 * back to the code-level DEFAULT_CHANNEL_FIELD_MAP, so behavior is unchanged until
 * an admin saves an override. Platform-global (channel API schemas are tenant-agnostic).
 */
export const channelFieldMappings = pgTable('channel_field_mappings', {
  fieldKey: text('field_key').primaryKey(),
  label: text('label').notNull(),
  isCustom: boolean('is_custom').notNull().default(false),
  /** 'scope' | 'attributes' */
  target: text('target').notNull().default('scope'),
  /** 'string' | 'string[]' */
  valueType: text('value_type').notNull().default('string'),
  /** Record<channelType, { kind:'path', path } | { kind:'const', value }> */
  paths: jsonb('paths').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})
