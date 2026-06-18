import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/**
 * SOP trigger type enum
 */
export const sopTriggerTypeEnum = pgEnum('sop_trigger_type', ['scheduled', 'event', 'manual'])
export type SopTriggerType = (typeof sopTriggerTypeEnum.enumValues)[number]

/**
 * SOP definition table — stores SOP templates (name, trigger config, node DAG JSON, version)
 *
 * Each editor save generates a new version; old versions are retained for execution history.
 * Active version is marked via is_active flag.
 */
export const sopDefinitions = pgTable(
  'sop_definitions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),

    /** Trigger type */
    triggerType: sopTriggerTypeEnum('trigger_type').notNull().default('manual'),

    /** Trigger config (ScheduledTrigger | EventTrigger | ManualTrigger) */
    triggerConfig: jsonb('trigger_config').notNull().default('{}'),

    /**
     * Node DAG JSON — SopNode[] serialization
     * Contains all node definitions, exits, and position info
     */
    nodes: jsonb('nodes').notNull().default('[]'),

    /**
     * Edge data JSON — SopEdge[] serialization
     * ReactFlow edge info, used for canvas rendering
     */
    edges: jsonb('edges').notNull().default('[]'),

    /** SOP-level max execution duration (minutes), default 1440 (24 hours) */
    sopTimeoutMinutes: integer('sop_timeout_minutes').notNull().default(1440),

    /** Max rejection cycles, default 3 */
    maxRejectionCycles: integer('max_rejection_cycles').notNull().default(3),

    /** Max retries (on node execution error), default 3 */
    maxRetries: integer('max_retries').notNull().default(3),

    /** Creator ID */
    createdBy: text('created_by').notNull(),

    /** Version number, incremented on each save */
    version: integer('version').notNull().default(1),

    /** Whether this is the active version */
    isActive: boolean('is_active').notNull().default(true),

    /**
     * Per-connection visibility rules (SopVisibilityRules). Null/absent ⇒ SOP
     * visible to everyone. Evaluated by the conversation engine before exposing
     * the SOP to the LLM.
     */
    visibilityRules: jsonb('visibility_rules').$type<Record<string, unknown> | null>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index('sop_definitions_name_idx').on(table.name),
    triggerTypeIdx: index('sop_definitions_trigger_type_idx').on(table.triggerType),
    isActiveIdx: index('sop_definitions_is_active_idx').on(table.isActive),
    createdAtIdx: index('sop_definitions_created_at_idx').on(table.createdAt),
    createdByIdx: index('sop_definitions_created_by_idx').on(table.createdBy),
  })
)
