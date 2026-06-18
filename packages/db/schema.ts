import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  json,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Custom tsvector type for full-text search
export const tsvector = customType<{
  data: string
}>({
  dataType() {
    return `tsvector`
  },
})

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  isSuperUser: boolean('is_super_user').notNull().default(false),
  approvalStatus: text('approval_status').notNull().default('approved'),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id').references(() => organization.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    userIdIdx: index('session_user_id_idx').on(table.userId),
    tokenIdx: index('session_token_idx').on(table.token),
  })
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    userIdIdx: index('account_user_id_idx').on(table.userId),
    accountProviderIdx: index('idx_account_on_account_id_provider_id').on(
      table.accountId,
      table.providerId
    ),
    uniqueUserProvider: uniqueIndex('account_user_provider_unique').on(
      table.userId,
      table.providerId
    ),
  })
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    identifierIdx: index('verification_identifier_idx').on(table.identifier),
    expiresAtIdx: index('verification_expires_at_idx').on(table.expiresAt),
  })
)

export const settings = pgTable('settings', {
  id: text('id').primaryKey(), // Use the user id as the key
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
    .unique(), // One settings record per user

  // General settings
  theme: text('theme').notNull().default('dark'),
  autoConnect: boolean('auto_connect').notNull().default(true),

  // Privacy settings
  telemetryEnabled: boolean('telemetry_enabled').notNull().default(true),

  // Email preferences
  emailPreferences: json('email_preferences').notNull().default('{}'),

  // Billing usage notifications preference
  billingUsageNotificationsEnabled: boolean('billing_usage_notifications_enabled')
    .notNull()
    .default(true),

  // UI preferences
  showTrainingControls: boolean('show_training_controls').notNull().default(false),
  superUserModeEnabled: boolean('super_user_mode_enabled').notNull().default(true),

  // Notification preferences
  errorNotificationsEnabled: boolean('error_notifications_enabled').notNull().default(true),

  // Canvas preferences
  snapToGridSize: integer('snap_to_grid_size').notNull().default(0), // 0 = off, 10-50 = grid size
  showActionBar: boolean('show_action_bar').notNull().default(true),

  // Copilot preferences - maps model_id to enabled/disabled boolean
  copilotEnabledModels: jsonb('copilot_enabled_models').notNull().default('{}'),

  // Copilot auto-allowed integration tools - array of tool IDs that can run without confirmation
  copilotAutoAllowedTools: jsonb('copilot_auto_allowed_tools').notNull().default('[]'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKey = pgTable(
  'api_key',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }), // Only set for workspace keys
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    key: text('key').notNull().unique(),
    type: text('type').notNull().default('personal'),
    lastUsed: timestamp('last_used', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => ({
    workspaceTypeCheck: check(
      'workspace_type_check',
      sql`(type = 'workspace' AND workspace_id IS NOT NULL) OR (type = 'personal' AND workspace_id IS NULL)`
    ),
    workspaceTypeIdx: index('api_key_workspace_type_idx').on(table.workspaceId, table.type),
    userTypeIdx: index('api_key_user_type_idx').on(table.userId, table.type),
  })
)

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  logo: text('logo'),
  metadata: json('metadata'),
  storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'admin' or 'member' - team-level permissions only
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdUnique: uniqueIndex('member_user_id_unique').on(table.userId), // Users can only belong to one org
    organizationIdIdx: index('member_organization_id_idx').on(table.organizationId),
  })
)

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: index('invitation_email_idx').on(table.email),
    organizationIdIdx: index('invitation_organization_id_idx').on(table.organizationId),
  })
)

export const workspace = pgTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  billedAccountUserId: text('billed_account_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'no action' }),
  allowPersonalApiKeys: boolean('allow_personal_api_keys').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceFiles = pgTable(
  'workspace_files',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    context: text('context').notNull(), // 'workspace', 'copilot', 'chat', 'knowledge-base', 'profile-pictures', 'general', 'execution'
    originalName: text('original_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: index('workspace_files_key_idx').on(table.key),
    userIdIdx: index('workspace_files_user_id_idx').on(table.userId),
    workspaceIdIdx: index('workspace_files_workspace_id_idx').on(table.workspaceId),
    contextIdx: index('workspace_files_context_idx').on(table.context),
  })
)

export const permissionTypeEnum = pgEnum('permission_type', ['admin', 'write', 'read'])

export const permissions = pgTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // 'workspace', 'workflow', 'organization', etc.
    entityId: text('entity_id').notNull(), // ID of the workspace, workflow, etc.
    permissionType: permissionTypeEnum('permission_type').notNull(), // Use enum instead of text
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary access pattern - get all permissions for a user
    userIdIdx: index('permissions_user_id_idx').on(table.userId),

    // Entity-based queries - get all users with permissions on an entity
    entityIdx: index('permissions_entity_idx').on(table.entityType, table.entityId),

    // User + entity type queries - get user's permissions for all workspaces
    userEntityTypeIdx: index('permissions_user_entity_type_idx').on(table.userId, table.entityType),

    // Specific permission checks - does user have specific permission on entity
    userEntityPermissionIdx: index('permissions_user_entity_permission_idx').on(
      table.userId,
      table.entityType,
      table.permissionType
    ),

    // User + specific entity queries - get user's permissions for specific entity
    userEntityIdx: index('permissions_user_entity_idx').on(
      table.userId,
      table.entityType,
      table.entityId
    ),

    // Uniqueness constraint - prevent duplicate permission rows (one permission per user/entity)
    uniquePermissionConstraint: uniqueIndex('permissions_unique_constraint').on(
      table.userId,
      table.entityType,
      table.entityId
    ),
  })
)

// Idempotency keys for preventing duplicate processing across all webhooks and triggers
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    key: text('key').primaryKey(),
    result: json('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for cleanup operations by creation time
    createdAtIdx: index('idempotency_key_created_at_idx').on(table.createdAt),
  })
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    actorName: text('actor_name'),
    actorEmail: text('actor_email'),
    resourceName: text('resource_name'),
    description: text('description'),
    metadata: jsonb('metadata').default('{}'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('audit_log_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    actorCreatedIdx: index('audit_log_actor_created_idx').on(table.actorId, table.createdAt),
    resourceIdx: index('audit_log_resource_idx').on(table.resourceType, table.resourceId),
    actionIdx: index('audit_log_action_idx').on(table.action),
  })
)

export const permissionGroup = pgTable(
  'permission_group',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    config: jsonb('config').notNull().default('{}'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    autoAddNewMembers: boolean('auto_add_new_members').notNull().default(false),
  },
  (table) => ({
    organizationIdIdx: index('permission_group_organization_id_idx').on(table.organizationId),
    createdByIdx: index('permission_group_created_by_idx').on(table.createdBy),
    orgNameUnique: uniqueIndex('permission_group_org_name_unique').on(
      table.organizationId,
      table.name
    ),
    autoAddNewMembersUnique: uniqueIndex('permission_group_org_auto_add_unique')
      .on(table.organizationId)
      .where(sql`auto_add_new_members = true`),
  })
)

export const permissionGroupMember = pgTable(
  'permission_group_member',
  {
    id: text('id').primaryKey(),
    permissionGroupId: text('permission_group_id')
      .notNull()
      .references(() => permissionGroup.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by').references(() => user.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    permissionGroupIdIdx: index('permission_group_member_group_id_idx').on(table.permissionGroupId),
    userIdUnique: uniqueIndex('permission_group_member_user_id_unique').on(table.userId),
  })
)

export { accessRules } from './schema/access-rules'
export type { AlertCategory, AlertSeverity, AlertStatus } from './schema/audit-alerts'
export {
  alertCategoryEnum,
  alertSeverityEnum,
  alertStatusEnum,
  anomalyAlerts,
} from './schema/audit-alerts'
export type {
  ConversationChannel,
  ConversationStatus,
  MessageRole,
} from './schema/conversations'
export {
  channelSessions,
  conversationChannelEnum,
  conversationMessages,
  conversationStatusEnum,
  conversations,
  messageRoleEnum,
} from './schema/conversations'
export { dailyStats } from './schema/daily-stats'
export type { EmployeeStatus } from './schema/employee'
export {
  digitalEmployees,
  employeeStatusEnum,
} from './schema/employee'
export { employeeConnections } from './schema/employee-connections'
export { employeeSkillBindings } from './schema/employee-skill-bindings'
export { employeeWorkflowBindings } from './schema/employee-workflow-bindings'
export type { ContactMethod, ContactMethodType } from './schema/human-employees'
export {
  CONTACT_METHOD_TYPES,
  CONTACT_TO_CONNECTION_TYPE,
  humanEmployees,
} from './schema/human-employees'
export { modelConfigs } from './schema/model-configs'
export { modelUsageLogs } from './schema/model-usage-logs'
export {
  platformPermissionDefs,
  platformRolePermissions,
} from './schema/permissions'
export type { PlatformRole } from './schema/platform-roles'
export {
  employeePlatformRoles,
  platformRoleEnum,
} from './schema/platform-roles'
export { platformSettings } from './schema/platform-settings'
export { channelFieldMappings } from './schema/channel-field-mappings'
// ===== Digital Employee Platform Schema =====
export { roles } from './schema/roles'
export type {
  SandboxRunStatus,
  SandboxRunType,
} from './schema/sandbox-runs'
export {
  SANDBOX_TERMINAL_STATUSES,
  sandboxRunStatusEnum,
  sandboxRuns,
  sandboxRunTypeEnum,
} from './schema/sandbox-runs'
export { scheduledTasks } from './schema/scheduled-tasks'
export type { SopTriggerType } from './schema/sop-definitions'
export {
  sopDefinitions,
  sopTriggerTypeEnum,
} from './schema/sop-definitions'
export type {
  SopExecutionStatus,
  SopNodeStatus,
  SopPauseDecision,
  SopPauseStatus,
} from './schema/sop-executions'
export {
  SOP_TERMINAL_STATUSES,
  sopExecutionStatusEnum,
  sopExecutions,
  sopNodeExecutions,
  sopNodeStatusEnum,
  sopPauseDecisionEnum,
  sopPauseStates,
  sopPauseStatusEnum,
} from './schema/sop-executions'
export type {
  ConnectionStatus,
  ConnectionType,
  HealthMessageI18n,
} from './schema/system-connections'
export {
  CONNECTION_STATUSES,
  CONNECTION_TYPES,
  systemConnections,
} from './schema/system-connections'
export type { TaskStatus, TaskTriggerType } from './schema/task-executions'
export {
  taskExecutions,
  taskStatusEnum,
  taskTriggerTypeEnum,
} from './schema/task-executions'
export { toolApiKeys } from './schema/tool-api-keys'
export { toolInstanceApiKeys } from './schema/tool-instance-api-keys'
export type { ToolDevMessageKind } from './schema/tool-dev-messages'
export { toolDevMessages } from './schema/tool-dev-messages'
export type {
  ToolDevPendingActionStatus,
  ToolDevPendingActionType,
} from './schema/tool-dev-pending-actions'
export { toolDevPendingActions } from './schema/tool-dev-pending-actions'
export type {
  ToolDevApprovedDependencies,
  ToolDevContainerStatus,
  ToolDevPhaseHistoryEntry,
  ToolDevSessionStatus,
} from './schema/tool-dev-sessions'
export { toolDevSessions } from './schema/tool-dev-sessions'
export type { NewToolExecution, ToolExecution } from './schema/tool-executions'
export { toolExecutions } from './schema/tool-executions'
export { toolInstances } from './schema/tool-instances'
export { tools } from './schema/tools'
export type { WorkLogType } from './schema/work-logs'
export {
  workLogs,
  workLogTypeEnum,
} from './schema/work-logs'
