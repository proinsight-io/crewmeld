import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from '../schema'
import { modelConfigs } from './model-configs'
import { tools } from './tools'

/**
 * Tool Dev Studio session lifecycle status.
 *
 * - `active`: User is iterating on the tool inside the studio.
 * - `adopted`: The session has been promoted into a real tool definition.
 * - `archived`: User dismissed the session; kept for history only.
 */
export type ToolDevSessionStatus = 'active' | 'adopted' | 'archived'

/**
 * Container lifecycle status for the session's sandbox.
 *
 * Transitions:
 *   destroyed -> creating -> running -> expired
 *   running -> destroyed (explicit teardown)
 */
export type ToolDevContainerStatus = 'creating' | 'running' | 'expired' | 'destroyed'

/**
 * One entry of the per-session phase history audit trail.
 */
export interface ToolDevPhaseHistoryEntry {
  phase: string
  enteredAt: string
}

/**
 * Approved dependency allowlist applied to the session's sandbox.
 *
 * `libraries` are package identifiers (pip/npm names); `domains` are network
 * egress hostnames the operator has accepted for outbound traffic.
 */
export interface ToolDevApprovedDependencies {
  libraries: string[]
  domains: string[]
}

/**
 * Tool Dev Studio sessions — Sub-spec B §4.1.
 *
 * One row per studio session belonging to a single user. The session owns the
 * workspace + claude state directories on disk plus an optional running
 * container (uniqueness of running containers per user is enforced via a
 * partial unique index).
 *
 * Note: `userId` is `text` to match the `user.id` column (better-auth uses
 * text PKs). The spec template used `uuid`, but project convention is text.
 */
export const toolDevSessions = pgTable(
  'tool_dev_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title'),
    status: text('status', { enum: ['active', 'adopted', 'archived'] })
      .$type<ToolDevSessionStatus>()
      .notNull()
      .default('active'),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }),
    /** Associated tool template ID (set on first adopt; ON DELETE SET NULL makes orphans visible in "new tool" list) */
    toolId: text('tool_id').references(() => tools.id, { onDelete: 'set null' }),
    /** First ~60 chars of the last user/assistant message, for dropdown preview */
    lastMessagePreview: text('last_message_preview'),

    pipelinePhases: jsonb('pipeline_phases').$type<string[] | null>(),
    phase: text('phase'),
    phaseHistory: jsonb('phase_history').$type<ToolDevPhaseHistoryEntry[]>().notNull().default([]),

    activeContainerId: text('active_container_id'),
    containerStatus: text('container_status', {
      enum: ['creating', 'running', 'expired', 'destroyed'],
    })
      .$type<ToolDevContainerStatus>()
      .notNull()
      .default('destroyed'),

    workspaceDir: text('workspace_dir').notNull(),
    /**
     * Host end of the `/root/.claude/projects` bind mount. The name is a
     * historical artifact — earlier revisions mounted the whole `/root/.claude`
     * tree before we narrowed the scope so the image's plugins and permission
     * settings stay visible.
     */
    claudeStateDir: text('claude_state_dir').notNull(),

    rightPanelVisible: boolean('right_panel_visible').notNull().default(false),

    approvedDependencies: jsonb('approved_dependencies')
      .$type<ToolDevApprovedDependencies>()
      .notNull()
      .default({ libraries: [], domains: [] }),

    /**
     * Cache metadata for the most recent successfully packaged tool code.
     * Used to skip re-syncing when workspace contents have not changed
     * since the last run-test invocation.
     *
     * - sha256: Hex digest of packaged content; computed at package time
     * - packagedAt: ISO timestamp
     * - sizeBytes: Packaged size in bytes
     *
     * Per spec 2026-05-28-cross-platform-nfs-volume-design.md §7.2 the
     * legacy MinIO `s3Key` and the transitional `codeDir` were dropped at
     * Task 17; callers now derive the on-NFS code dir via
     * `paths.toolCode.forBff(toolId)`.
     */
    lastPackage: jsonb('last_package').$type<{
      sha256: string
      packagedAt: string
      sizeBytes: number
    } | null>(),

    /**
     * Reference to the `model_configs` row chosen at session creation time.
     * When null, the container env falls back to the global `ANTHROPIC_*` vars
     * (Sub-spec C decision D2). `ON DELETE SET NULL` keeps existing sessions
     * alive — they simply revert to the global-env fallback — when the user
     * deletes the underlying model config.
     */
    modelConfigId: text('model_config_id').references(() => modelConfigs.id, {
      onDelete: 'set null',
    }),
    /** Display label for the resolved model, written by model-resolver. */
    modelName: text('model_name'),
    totalInputTokens: bigint('total_input_tokens', { mode: 'number' }).notNull().default(0),
    totalOutputTokens: bigint('total_output_tokens', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('tool_dev_sessions_user_idx').on(t.userId, t.status, t.lastActiveAt.desc()),
    uniqueRunning: uniqueIndex('tool_dev_sessions_user_running_uidx')
      .on(t.userId)
      .where(sql`container_status = 'running'`),
  })
)
