import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sopDefinitions } from './sop-definitions'

/**
 * SOP execution status enum — 8 states (whitepaper section 8.9.1)
 */
export const sopExecutionStatusEnum = pgEnum('sop_execution_status', [
  'pending',
  'running',
  'paused_for_human',
  // Suspended mid-node waiting for an async tool to complete and wake the SOP
  // (via HTTP callback for pod tools, or in-process resume for api tools).
  // Distinct from paused_for_human so the human-approval resume path never
  // matches it.
  'paused_for_tool',
  'completed',
  'timed_out',
  'error',
  'failed',
  'cancelled',
])
export type SopExecutionStatus = (typeof sopExecutionStatusEnum.enumValues)[number]

/** Terminal status set — used for cold recovery queries */
export const SOP_TERMINAL_STATUSES: SopExecutionStatus[] = [
  'completed',
  'timed_out',
  'error',
  'failed',
  'cancelled',
]

/**
 * SOP node execution status enum
 */
export const sopNodeStatusEnum = pgEnum('sop_node_status', [
  'pending',
  'running',
  'completed',
  'skipped',
  'error',
])
export type SopNodeStatus = (typeof sopNodeStatusEnum.enumValues)[number]

/**
 * Human confirmation decision enum
 */
export const sopPauseDecisionEnum = pgEnum('sop_pause_decision', [
  'approved',
  'rejected',
  'timeout',
])
export type SopPauseDecision = (typeof sopPauseDecisionEnum.enumValues)[number]

/**
 * Pause status enum
 */
export const sopPauseStatusEnum = pgEnum('sop_pause_status', ['waiting', 'decided', 'timeout'])
export type SopPauseStatus = (typeof sopPauseStatusEnum.enumValues)[number]

/**
 * SOP execution instance table — one record per trigger
 *
 * state_snapshot persists full state snapshot (whitepaper section 8.9.3),
 * supporting checkpoint and cold recovery.
 */
export const sopExecutions = pgTable(
  'sop_executions',
  {
    id: text('id').primaryKey(),

    /** Associated SOP definition (nullable: preserves historical execution records after SOP deletion) */
    sopDefinitionId: text('sop_definition_id').references(() => sopDefinitions.id, {
      onDelete: 'set null',
    }),

    /** SOP version at execution time (snapshot; definition changes do not affect running instances) */
    sopVersion: integer('sop_version').notNull(),

    /** Triggered by user ID */
    triggeredBy: text('triggered_by').notNull(),

    /** Associated scheduled task ID (recorded for scheduled triggers; null for manual triggers) */
    scheduledTaskId: text('scheduled_task_id'),

    /** Current status */
    status: sopExecutionStatusEnum('status').notNull().default('pending'),

    /**
     * Full state snapshot — SopStateSnapshot JSONB
     * Contains currentNodeId, nodeStates, executionPath, exitDecisions, variables, etc.
     */
    stateSnapshot: jsonb('state_snapshot').notNull().default('{}'),

    /** Trigger data (manual trigger params, event payload, etc.) */
    triggerData: jsonb('trigger_data').default('{}'),

    /** Retry count */
    retryCount: integer('retry_count').notNull().default(0),

    /** Rejection cycle count */
    rejectionCount: integer('rejection_count').notNull().default(0),

    /** Error message */
    errorMessage: text('error_message'),

    /**
     * Whether the engine's completion notifier should push the final result to
     * the channel. Default true (fire-and-forget triggers — schedules, webhooks —
     * have no in-turn waiter). A conversation trigger sets this false: it will
     * deliver the result in-turn (the LLM's reply) within the sync grace window,
     * so the engine must NOT also push. If the conversation gives up waiting
     * (grace expired / paused), it atomically flips this back to true, handing
     * delivery to the engine. The status-guarded flip + the notifier's gate
     * guarantee exactly-once delivery.
     */
    pushByEngine: boolean('push_by_engine').notNull().default(true),

    /**
     * i18n metadata for errorMessage — written by engine.ts when a structured
     * error is recorded.  Shape: { errorI18nKey: string; errorI18nParams?: Record<string,string|number> }
     */
    metadata: jsonb('metadata').default('{}'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sopDefinitionIdIdx: index('sop_exec_definition_id_idx').on(table.sopDefinitionId),
    statusIdx: index('sop_exec_status_idx').on(table.status),
    statusCreatedIdx: index('sop_exec_status_created_idx').on(table.status, table.createdAt),
    startedAtIdx: index('sop_exec_started_at_idx').on(table.startedAt),
    triggeredByIdx: index('sop_exec_triggered_by_idx').on(table.triggeredBy),
  })
)

/**
 * SOP node execution records — one record per node execution
 */
export const sopNodeExecutions = pgTable(
  'sop_node_executions',
  {
    id: text('id').primaryKey(),

    /** Associated SOP execution instance */
    executionId: text('execution_id')
      .notNull()
      .references(() => sopExecutions.id, { onDelete: 'cascade' }),

    /** Node ID (corresponds to SopNode.id) */
    nodeId: text('node_id').notNull(),

    /** Node name (redundant, for query display convenience) */
    nodeName: text('node_name').notNull(),

    /** Node type */
    nodeType: text('node_type').notNull(),

    /** Node execution status */
    status: sopNodeStatusEnum('status').notNull().default('pending'),

    /**
     * Node execution result JSONB
     * digital_employee: workflow execution output
     * human_employee: manually submitted result
     * human_confirm: { decision, comment }
     */
    result: jsonb('result'),

    /** Associated workflow run ID (digital_employee nodes only) */
    workflowRunId: text('workflow_run_id'),

    /** Error message */
    errorMessage: text('error_message'),

    /** Retry count */
    retryCount: integer('retry_count').notNull().default(0),

    /** Selected exit ID */
    exitId: text('exit_id'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    executionIdIdx: index('sop_node_exec_execution_id_idx').on(table.executionId),
    executionNodeIdx: index('sop_node_exec_exec_node_idx').on(table.executionId, table.nodeId),
    statusIdx: index('sop_node_exec_status_idx').on(table.status),
  })
)

/**
 * SOP human confirmation pause state table
 *
 * First-Wins concurrency control:
 * UPDATE sop_pause_states SET status = 'decided', decision = $1
 * WHERE id = $2 AND status = 'waiting' RETURNING *
 *
 * Only the first successful UPDATE takes effect; subsequent ones return 0 rows -> 409 Conflict
 */
export const sopPauseStates = pgTable(
  'sop_pause_states',
  {
    id: text('id').primaryKey(),

    /** Associated SOP execution instance */
    executionId: text('execution_id')
      .notNull()
      .references(() => sopExecutions.id, { onDelete: 'cascade' }),

    /** Paused node ID */
    nodeId: text('node_id').notNull(),

    /** Pause status */
    status: sopPauseStatusEnum('status').notNull().default('waiting'),

    /** Assignee ID (plain text, no foreign key) */
    assigneeId: text('assignee_id'),

    /** Decision result */
    decision: sopPauseDecisionEnum('decision'),

    /** Decided by user ID */
    decidedBy: text('decided_by'),

    /** Decision comment */
    comment: text('comment'),

    /** BullMQ timeout Job ID (for cancelling timer) */
    timeoutJobId: text('timeout_job_id'),

    /** Approval timeout absolute time; used to rebuild BullMQ delayed jobs during cold recovery */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Approval token — for session-less HTML5 approval page */
    approvalToken: text('approval_token'),

    /** Token expiration time */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    /** WeCom card update response_code */
    cardResponseCode: text('card_response_code'),

    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    executionIdIdx: index('sop_pause_execution_id_idx').on(table.executionId),
    executionNodeIdx: index('sop_pause_exec_node_idx').on(table.executionId, table.nodeId),
    statusIdx: index('sop_pause_status_idx').on(table.status),
    approvalTokenIdx: index('sop_pause_approval_token_idx').on(table.approvalToken),
  })
)
