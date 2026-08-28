import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { systemConnections } from './system-connections'
import { tools } from './tools'

/**
 * Tool instance table — each template can create multiple instances, each independently deployed with separate params
 *
 * Templates (tools table) store code and parameter schema,
 * instances store runtime preset parameter values, env vars, and deployment status.
 */
export const toolInstances = pgTable(
  'tool_instances',
  {
    id: text('id').primaryKey(),
    /** Associated template ID */
    templateId: text('template_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    /** Instance name (editable) */
    name: text('name').notNull(),
    /** Associated system connection ID (nullable, only for tools requiring connections) */
    connectionId: text('connection_id').references(() => systemConnections.id, {
      onDelete: 'set null',
    }),
    /** Instance-specific preset parameter values */
    presetParams: jsonb('preset_params'),
    /** Instance-specific env vars (secret params), injected into Pod on deployment */
    envVars: jsonb('env_vars'),
    /** K8S deployment info JSONB: { status, endpoint, nodePort, deployedAt, errorMessage } */
    deploy: jsonb('deploy'),
    /** Whether this instance is published through the service gateway. */
    publishedAsService: boolean('published_as_api').notNull().default(false),
    /** Service gateway authentication mode. */
    serviceAuthMode: text('service_auth_mode').notNull().default('api-key'),
    /** Service exposure scope. */
    serviceVisibility: text('service_visibility').notNull().default('internal'),
    /** Optional public hostname routed to this service. */
    serviceDomain: text('service_domain'),
    /** Desired number of OpenSandbox replicas. */
    desiredReplicas: integer('desired_replicas').notNull().default(1),
    /** Creator user ID */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    templateIdIdx: index('ti_template_id_idx').on(table.templateId),
    connectionIdIdx: index('ti_connection_id_idx').on(table.connectionId),
    createdByIdx: index('ti_created_by_idx').on(table.createdBy),
    serviceDomainUnique: uniqueIndex('ti_service_domain_unique_idx').on(table.serviceDomain),
  })
)
