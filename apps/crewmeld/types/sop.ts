/** SOP node type */
export type SopNodeType = 'digital_employee' | 'human_employee' | 'human_confirm' | 'switch' // Multi-branch (Switch)

/** Condition branch config (for condition / switch nodes) */
export interface ConditionConfig {
  /** Evaluation field (optional; when empty, LLM evaluates full output) */
  field?: string
  /** Operator (used by condition nodes) */
  operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains'
  /** Comparison value (used by condition nodes) */
  value?: string | number | boolean
  /** Switch branch mapping: value -> exit ID (used by switch nodes) */
  cases?: Array<{ value: string | number | boolean; exitId: string }>
}

/** SOP node definition (whitepaper section 8.4.1) */
export interface SopNode {
  id: string
  name: string
  type: SopNodeType
  executorId?: string
  workflowId?: string
  toolIds?: string[]
  useKnowledgeBase?: boolean
  description?: string
  timeoutMinutes?: number
  /** Approval notification method (multi-platform, from collaborator contact method types, default ['email']) */
  notifyMethod?: string | string[]
  /** Approver list (human_confirm nodes support multiple approvers, First-Wins) */
  approvers?: string[]
  /**
   * Approver source for human_employee approval nodes:
   * - 'assignee' (default): send to the configured collaborator (executorId)
   * - 'requester_leader': send to the direct leader of whoever triggered the SOP
   *   (from _meta.identity.leaderId, IM channels only); executorId, if set,
   *   serves as the fallback approver when no leader can be reached.
   */
  approverSource?: 'assignee' | 'requester_leader'
  /** Condition/branch config (for condition / switch nodes) */
  conditionConfig?: ConditionConfig
  exits: SopExit[]
  position: { x: number; y: number }
}

/** Exit type */
export type SopExitType = 'normal' | 'error'

/** Exit definition */
export interface SopExit {
  id: string
  label: string
  targetNodeId: string | null
  condition?: SopCondition
  /** Exit type: normal=standard exit, error=error exit (followed after retries exhausted) */
  type?: SopExitType
}

/** Exit condition */
export interface SopCondition {
  /**
   * - approval_result: branch on a human_confirm decision
   * - workflow_output / variable: branch on the upstream node's output
   * - identity: branch on the caller's injected identity (positions / leaderId / orgUnitIds)
   * - always: default/fallback exit
   */
  type: 'approval_result' | 'workflow_output' | 'variable' | 'identity' | 'always'
  operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains'
  /** For identity conditions: positions | leaderId | orgUnitIds | employeeId | employeeNo. Otherwise a dot-path into the node output. */
  field?: string
  value?: string | number | boolean
}

/** Scheduled trigger config */
export interface ScheduledTrigger {
  cron: string
  timezone?: string
}

/** Event trigger config */
export interface EventTrigger {
  eventType: string
  sourceChannel?: string
  filterRules?: Array<{
    field: string
    operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt'
    value: string | number | boolean
  }>
}

/** Manual trigger config (no configuration needed) */
export type ManualTrigger = {}

export type SopTriggerConfig = ScheduledTrigger | EventTrigger | ManualTrigger

/** State snapshot (whitepaper section 8.9.3) */
export interface SopStateSnapshot {
  currentNodeId: string
  nodeStates: Record<string, SopNodeState>
  executionPath: string[]
  exitDecisions: Record<string, SopExitDecision>
  variables: Record<string, unknown>
  workflowResults: Record<string, SopWorkflowResult>
  triggerData?: Record<string, unknown>
}

/** Single node state */
export interface SopNodeState {
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error'
  startedAt?: string
  completedAt?: string
  retryCount: number
  output?: Record<string, unknown>
  exitId?: string
}

/** Human confirmation decision record */
export interface SopExitDecision {
  decision: 'approved' | 'rejected'
  decidedBy: string
  decidedAt: string
  comment?: string
}

/** Workflow execution result */
export interface SopWorkflowResult {
  workflowId: string
  runId: string
  status: string
  output?: Record<string, unknown>
}

/**
 * SSE event types — use 'sop:' prefix, non-conflicting with sandbox module's 'sandbox:' prefix.
 */
export type SopEventType =
  | 'sop:started'
  | 'sop:node:started'
  | 'sop:node:completed'
  | 'sop:node:error'
  | 'sop:paused'
  | 'sop:resumed'
  | 'sop:completed'
  | 'sop:error'
  | 'sop:timed_out'
  | 'sop:cancelled'
  | 'sop:workflow:started'
  | 'sop:workflow:completed'

/** SSE event */
export interface SopExecutionEvent {
  type: SopEventType
  executionId: string
  nodeId?: string
  timestamp: string
  data?: Record<string, unknown>
}

/** API payload — submitted when saving from editor */
export interface SopDefinitionPayload {
  name: string
  description?: string
  triggerType: string
  triggerConfig: Record<string, unknown>
  sopTimeoutMinutes: number
  maxRejectionCycles: number
  maxRetries?: number
  isActive?: boolean
  nodes: SopNode[]
  edges: SopSerializedEdge[]
}

/** Serialized edge */
export interface SopSerializedEdge {
  id: string
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
}

/** Node execution result */
export interface NodeExecutionResult {
  output?: Record<string, unknown>
  exitId?: string
  paused?: boolean
  /**
   * Why the node paused. 'human' (default) waits for a human approval decision;
   * 'tool' waits for an async tool callback. The engine maps these to the
   * paused_for_human / paused_for_tool execution statuses respectively.
   */
  pauseKind?: 'human' | 'tool'
  /**
   * Node task id (work_logs grouping key) for an async-tool pause. The engine
   * re-checks pending tool calls right after suspending to close the race where
   * a fast tool's callback fires before the suspend transition lands.
   */
  taskId?: string
  error?: string
  /** Flag for error exit path (set by engine after retries exhausted) */
  errorExit?: boolean
}

/** BullMQ timeout job payload */
export interface TimeoutJobPayload {
  executionId: string
  nodeId?: string
  pauseId?: string
  type: 'node' | 'sop'
}

/** BullMQ async-tool watchdog payload — fails a call that never called back. */
export interface AsyncToolWatchdogPayload {
  executionId: string
  callId: string
}

/**
 * Notification job payload — enqueued per recipient, one job per recipient
 *
 * The SOP module only determines "who to notify", not the delivery channel.
 * The NotificationDispatcher Worker (Doc 06 - Collaborator Management Module) receives the job,
 * looks up the recipient's contact_methods, and fans out delivery to all configured channels in parallel.
 */
export interface NotificationJobPayload {
  executionId: string
  nodeId: string
  recipientId: string
  recipientName: string
  approvalToken: string
  messageTemplate: string
  /** Notification method selected in SOP editor (multi-platform, e.g. ['email', 'feishu']) */
  notifyMethod?: string | string[]
  /** Digital employee ID that triggered the conversation (for looking up bound channel connections, avoiding cross-app) */
  sourceEmployeeId?: string
  /** Approver source: 'assignee' (default) or 'requester_leader' (deliver to the requester's leader) */
  approverSource?: 'assignee' | 'requester_leader'
  contextData: {
    sopName: string
    nodeName: string
    aiSummary?: string
    deadline?: string
    pauseId: string
    /** Requester's direct leader id (when approverSource='requester_leader'), channel-native */
    leaderId?: string
    /** Channel the requester came from (e.g. 'feishu'), used to deliver to the leader */
    requesterChannel?: string
    /** Execution result of the previous digital employee node (JSON string) */
    previousNodeResult?: string
    previousNodeName?: string
    /** Name of the user who triggered the conversation (shown as initiator on approval cards) */
    senderName?: string
    /** Email of the user who triggered the conversation (sender address for email channel, used as Reply-To in approval emails) */
    senderEmail?: string
    /** Externally accessible baseUrl (injected from request headers when API-triggered, used for building approval links) */
    baseUrl?: string
    /** User language code ('zh' | 'en' etc., detected by conversation engine and passed via triggerData._meta) */
    userLanguage?: string
  }
}
