import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export interface HealthMessageI18n {
  key: string
  params?: Record<string, string>
}

export const CONNECTION_TYPES = [
  'wecom',
  'dingtalk',
  'feishu',
  'discord',
  'crm',
  'database',
  'custom_api',
  'openclaw',
  'dify',
  'n8n',
  'email',
  'telegram',
  'ragflow',
  'baidu_ocr',
  'wxoa',
] as const
export type ConnectionType = (typeof CONNECTION_TYPES)[number]

export const CONNECTION_STATUSES = ['connected', 'disconnected', 'error', 'testing'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const systemConnections = pgTable(
  'system_connections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    configEncrypted: text('config_encrypted').notNull(),
    status: text('status').notNull().default('disconnected'),
    lastHealthCheck: timestamp('last_health_check', { withTimezone: true }),
    lastHealthMessageI18n: jsonb('last_health_message_i18n').$type<HealthMessageI18n>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    typeIdx: index('system_connections_type_idx').on(table.type),
    statusIdx: index('system_connections_status_idx').on(table.status),
  })
)
