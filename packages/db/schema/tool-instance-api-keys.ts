import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { toolInstances } from './tool-instances'

/**
 * Per-instance API keys for external tool invocation.
 *
 * Each key is hashed with SHA-256-HMAC before storage; the plaintext is
 * returned exactly once on creation. Redis caches active keys for fast
 * lookup (see api-key-service.ts).
 *
 * NOT to be confused with `tool_api_keys` which stores global third-party
 * API keys (Alibaba Cloud AppCode, etc.) used during AI tool generation.
 */
export const toolInstanceApiKeys = pgTable(
  'tool_instance_api_keys',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => toolInstances.id, { onDelete: 'cascade' }),
    /** Human-readable label, e.g. "生产环境" */
    name: text('name').notNull(),
    /** First 12 chars of the plaintext key, for display (e.g. "cmk_a1b2c3d4") */
    keyPrefix: text('key_prefix').notNull(),
    /** SHA-256-HMAC hash of the full plaintext key */
    hashedKey: text('hashed_key').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    instanceIdx: index('tiak_instance_id_idx').on(table.instanceId),
    hashedKeyIdx: index('tiak_hashed_key_idx').on(table.hashedKey),
  })
)
