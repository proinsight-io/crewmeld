import type { ConnectionStatus, ConnectionType, HealthMessageI18n } from '@crewmeld/db/schema'

export type { ConnectionType, ConnectionStatus, HealthMessageI18n }

/** Database subtypes */
export const DATABASE_SUBTYPES = [
  'postgresql',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'mongodb',
  'redis',
] as const
export type DatabaseSubtype = (typeof DATABASE_SUBTYPES)[number]

export const DATABASE_SUBTYPE_LABELS: Record<DatabaseSubtype, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  mongodb: 'MongoDB',
  redis: 'Redis',
}

export const DATABASE_SUBTYPE_ICONS: Record<DatabaseSubtype, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  mariadb: '🦭',
  sqlserver: '🪟',
  oracle: '🔴',
  mongodb: '🍃',
  redis: '🔻',
}

export const DATABASE_SUBTYPE_DEFAULT_PORTS: Record<DatabaseSubtype, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  oracle: 1521,
  mongodb: 27017,
  redis: 6379,
}

/** Message channel types - separated from system connections */
export const CHANNEL_TYPE_LIST: ConnectionType[] = [
  'wecom',
  'dingtalk',
  'feishu',
  'email',
  'telegram',
  'discord',
  'wxoa',
]

/** Pure system connection types (excluding channels) */
export const SYSTEM_CONNECTION_TYPE_LIST: ConnectionType[] = [
  /* 'crm', */ 'database',
  'openclaw', /* 'dify', */ 'n8n',
  'ragflow',
  'custom_api',
]

/** Single OpenClaw gateway entry in the pool. */
export interface OpenclawEndpoint {
  /** Operator-facing alias (e.g. "primary", "shanghai-backup"); surfaced in error messages. */
  label: string
  /** Gateway base URL, e.g. `http://openclaw:18789`. */
  url: string
  /** Bearer token for this gateway. */
  token: string
}

/** Hard cap on endpoints per connection — keeps UI and error messages bounded. */
export const OPENCLAW_ENDPOINTS_MAX = 10

export interface ConnectionConfig {
  /** WeCom */
  corpId?: string
  corpSecret?: string
  /** DingTalk/Feishu */
  appKey?: string
  appId?: string
  appSecret?: string
  robotCode?: string
  secret?: string
  aesKey?: string
  suiteKey?: string
  /** CRM / Custom API */
  apiEndpoint?: string
  apiKey?: string
  /** Custom API extension fields (Postman style) */
  httpMethod?: string
  params?: Array<{ key: string; value: string; enabled: boolean }>
  customHeaders?: Array<{ key: string; value: string; enabled: boolean }>
  authType?: 'none' | 'api_key' | 'bearer' | 'basic'
  bearerToken?: string
  basicUsername?: string
  basicPassword?: string
  bodyType?: 'none' | 'json' | 'form-urlencoded' | 'raw'
  bodyContent?: string
  /** Database */
  dbType?: DatabaseSubtype
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string
  ssl?: boolean
  /** MongoDB connection string mode */
  connectionString?: string
  /** OpenClaw Gateway pool — multiple endpoints with random pick + automatic failover. */
  endpoints?: OpenclawEndpoint[]
  /**
   * OpenClaw `model` to pass in `/v1/chat/completions` request body. Maps to
   * a specific OpenClaw agent. Defaults to `"openclaw"` (gateway's configured
   * default agent). Accepted values per OpenClaw docs:
   *   - `"openclaw"` / `"openclaw/default"` — default agent
   *   - `"openclaw/<agentId>"` — specific agent
   */
  openclawModel?: string
  /** n8n */
  n8nBaseUrl?: string
  n8nApiKey?: string
  n8nWorkflowId?: string
  /** Email (SMTP) */
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  fromName?: string
  fromAddress?: string
  /** Email (IMAP receive) */
  imapHost?: string
  imapPort?: number
  imapSecure?: boolean
  /** Discord */
  botToken?: string
  guildId?: string
  discordChannelId?: string
  /** WeCom self-built app channel integration */
  agentId?: string
  token?: string
  encodingAESKey?: string
  boundEmployeeId?: string
  webhookUrl?: string
  /** Telegram Bot */
  telegramBotToken?: string
  telegramWebhookSecret?: string
  /** WeChat Official Account */
  accountType?: 'service' | 'subscription'
  /** External knowledge base */
  ragflowEndpoint?: string
  ragflowTimeoutMs?: number
  /** General */
  headers?: Record<string, string>
  timeout?: number
}

export interface ConnectionTestResult {
  success: boolean
  messageKey: string
  messageParams?: Record<string, string>
  latencyMs: number
  details?: Record<string, string>
}

export type StatusIndicator = 'green' | 'yellow' | 'red' | 'gray'

export interface ConnectionCardData {
  id: string
  name: string
  type: ConnectionType
  description: string | null
  status: ConnectionStatus
  statusIndicator: StatusIndicator
  lastHealthCheck: string | null
  lastHealthMessageI18n: HealthMessageI18n | null
  createdAt: string
  updatedAt: string
  config: Record<string, unknown>
}

export interface CreateConnectionPayload {
  name: string
  type: ConnectionType
  description?: string
  config: ConnectionConfig
}

export interface UpdateConnectionPayload {
  name?: string
  description?: string
  config?: Partial<ConnectionConfig>
}

/** Connection type -> i18n key mapping, use t(CONNECTION_TYPE_I18N_KEYS[type]) in components */
export const CONNECTION_TYPE_I18N_KEYS: Record<ConnectionType, string> = {
  wecom: 'connections.typeWecom',
  dingtalk: 'connections.typeDingtalk',
  feishu: 'connections.typeFeishu',
  discord: 'connections.typeDiscord',
  crm: 'connections.typeCrm',
  database: 'connections.typeDatabase',
  custom_api: 'connections.typeCustomApi',
  openclaw: 'connections.typeOpenclaw',
  dify: 'connections.typeDify',
  n8n: 'connections.typeN8n',
  email: 'connections.typeEmail',
  telegram: 'connections.typeTelegram',
  ragflow: 'connections.typeRagflow',
  wxoa: 'connections.typeWxoa',
}

export const CONNECTION_TYPE_ICONS: Record<ConnectionType, string> = {
  wecom: '💬',
  dingtalk: '📱',
  feishu: '🐦',
  discord: '🎮',
  crm: '📇',
  database: '🗄️',
  custom_api: '🔌',
  openclaw: '🤖',
  dify: '🧠',
  n8n: '🔗',
  email: '✉️',
  telegram: '✈️',
  ragflow: '📚',
  wxoa: '📢',
}

export const CONNECTION_CONFIG_FIELDS: Record<
  ConnectionType,
  Array<{
    key: string
    label: string
    type: 'text' | 'password' | 'number' | 'boolean'
    required: boolean
    placeholder?: string
  }>
> = {
  wecom: [
    {
      key: 'corpId',
      label: 'connFields.wecomCorpId',
      type: 'text',
      required: true,
      placeholder: 'connFields.wecomCorpIdHint',
    },
    {
      key: 'corpSecret',
      label: 'connFields.wecomCorpSecret',
      type: 'password',
      required: true,
      placeholder: 'connFields.wecomCorpSecretHint',
    },
    {
      key: 'agentId',
      label: 'connFields.wecomAgentId',
      type: 'text',
      required: true,
      placeholder: 'connFields.wecomAgentIdHint',
    },
    {
      key: 'token',
      label: 'connFields.wecomToken',
      type: 'password',
      required: true,
      placeholder: 'connFields.wecomTokenHint',
    },
    {
      key: 'encodingAESKey',
      label: 'connFields.wecomEncodingAESKey',
      type: 'password',
      required: true,
      placeholder: 'connFields.wecomEncodingAESKeyHint',
    },
  ],
  dingtalk: [
    {
      key: 'appKey',
      label: 'connFields.dingtalkAppKey',
      type: 'text',
      required: true,
      placeholder: 'connFields.dingtalkAppKeyHint',
    },
    {
      key: 'appSecret',
      label: 'connFields.dingtalkAppSecret',
      type: 'password',
      required: true,
      placeholder: 'connFields.dingtalkAppSecretHint',
    },
    {
      key: 'robotCode',
      label: 'connFields.dingtalkRobotCode',
      type: 'text',
      required: false,
      placeholder: 'connFields.dingtalkRobotCodeHint',
    },
    {
      key: 'secret',
      label: 'connFields.dingtalkSecret',
      type: 'password',
      required: false,
      placeholder: 'connFields.dingtalkSecretHint',
    },
    {
      key: 'aesKey',
      label: 'connFields.dingtalkAesKey',
      type: 'password',
      required: false,
      placeholder: 'connFields.dingtalkAesKeyHint',
    },
    {
      key: 'token',
      label: 'connFields.dingtalkToken',
      type: 'password',
      required: false,
      placeholder: 'connFields.dingtalkTokenHint',
    },
  ],
  feishu: [
    {
      key: 'appId',
      label: 'connFields.feishuAppId',
      type: 'text',
      required: true,
      placeholder: 'connFields.feishuAppIdHint',
    },
    {
      key: 'appSecret',
      label: 'connFields.feishuAppSecret',
      type: 'password',
      required: true,
      placeholder: 'connFields.feishuAppSecretHint',
    },
    {
      key: 'encodingAESKey',
      label: 'connFields.feishuEncryptKey',
      type: 'password',
      required: false,
      placeholder: 'connFields.feishuEncryptKeyHint',
    },
    {
      key: 'token',
      label: 'connFields.feishuVerifyToken',
      type: 'password',
      required: false,
      placeholder: 'connFields.feishuVerifyTokenHint',
    },
  ],
  discord: [
    {
      key: 'botToken',
      label: 'connFields.discordBotToken',
      type: 'password',
      required: true,
      placeholder: 'connFields.discordBotTokenHint',
    },
    {
      key: 'guildId',
      label: 'connFields.discordGuildId',
      type: 'text',
      required: false,
      placeholder: 'connFields.discordGuildIdHint',
    },
    {
      key: 'discordChannelId',
      label: 'connFields.discordChannelId',
      type: 'text',
      required: false,
      placeholder: 'connFields.discordChannelIdHint',
    },
  ],
  crm: [
    {
      key: 'apiEndpoint',
      label: 'connFields.crmApiEndpoint',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com',
    },
    {
      key: 'apiKey',
      label: 'connFields.crmApiKey',
      type: 'password',
      required: true,
      placeholder: 'connFields.crmApiKeyHint',
    },
  ],
  database: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '5432',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'mydb',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'user',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ], // fallback, actual usage is DATABASE_CONFIG_FIELDS_BY_SUBTYPE
  custom_api: [
    {
      key: 'apiEndpoint',
      label: 'connFields.customApiEndpoint',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com',
    },
    {
      key: 'apiKey',
      label: 'connFields.customApiKey',
      type: 'password',
      required: false,
      placeholder: 'connFields.customApiKeyHint',
    },
  ],
  // OpenClaw uses a dedicated multi-endpoint editor (OpenclawEndpointsEditor),
  // not the generic field renderer. Keep the entry but leave it empty.
  openclaw: [],
  dify: [
    {
      key: 'difyBaseUrl',
      label: 'connFields.difyBaseUrl',
      type: 'text',
      required: true,
      placeholder: 'http://dify:5001/v1',
    },
    {
      key: 'difyAppApiKey',
      label: 'connFields.difyAppApiKey',
      type: 'password',
      required: true,
      placeholder: 'app-xxxxxxxx',
    },
    {
      key: 'difyAppType',
      label: 'connFields.difyAppType',
      type: 'text',
      required: true,
      placeholder: 'workflow / agent / chatbot',
    },
  ],
  n8n: [
    {
      key: 'n8nBaseUrl',
      label: 'connFields.n8nBaseUrl',
      type: 'text',
      required: true,
      placeholder: 'http://n8n:5678',
    },
    {
      key: 'n8nApiKey',
      label: 'connFields.n8nApiKey',
      type: 'password',
      required: true,
      placeholder: 'n8n API Key',
    },
    {
      key: 'n8nWorkflowId',
      label: 'connFields.n8nWorkflowId',
      type: 'text',
      required: false,
      placeholder: 'connFields.n8nWorkflowIdHint',
    },
  ],
  email: [
    {
      key: 'smtpHost',
      label: 'connFields.emailSmtpHost',
      type: 'text',
      required: true,
      placeholder: 'smtp.example.com',
    },
    {
      key: 'smtpPort',
      label: 'connFields.emailSmtpPort',
      type: 'number',
      required: true,
      placeholder: '465',
    },
    { key: 'smtpSecure', label: 'connFields.emailSmtpSecure', type: 'boolean', required: false },
    {
      key: 'username',
      label: 'connFields.emailUsername',
      type: 'text',
      required: true,
      placeholder: 'user@example.com',
    },
    {
      key: 'password',
      label: 'connFields.emailPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.emailPasswordHint',
    },
    {
      key: 'fromName',
      label: 'connFields.emailFromName',
      type: 'text',
      required: false,
      placeholder: 'connFields.emailFromNameHint',
    },
    {
      key: 'fromAddress',
      label: 'connFields.emailFromAddress',
      type: 'text',
      required: false,
      placeholder: 'noreply@example.com',
    },
    {
      key: 'imapHost',
      label: 'connFields.emailImapHost',
      type: 'text',
      required: false,
      placeholder: 'imap.example.com',
    },
    {
      key: 'imapPort',
      label: 'connFields.emailImapPort',
      type: 'number',
      required: false,
      placeholder: '993',
    },
    { key: 'imapSecure', label: 'connFields.emailImapSecure', type: 'boolean', required: false },
  ],
  telegram: [
    {
      key: 'telegramBotToken',
      label: 'connFields.telegramBotToken',
      type: 'password',
      required: true,
      placeholder: 'connFields.telegramBotTokenHint',
    },
    {
      key: 'telegramWebhookSecret',
      label: 'connFields.telegramWebhookSecret',
      type: 'password',
      required: false,
      placeholder: 'connFields.telegramWebhookSecretHint',
    },
  ],
  ragflow: [
    {
      key: 'ragflowEndpoint',
      label: 'connFields.ragflowEndpoint',
      type: 'text',
      required: true,
      placeholder: 'http://your-server:9380',
    },
    {
      key: 'apiKey',
      label: 'connFields.ragflowApiKey',
      type: 'password',
      required: true,
      placeholder: 'your-api-key',
    },
    {
      key: 'ragflowTimeoutMs',
      label: 'connFields.ragflowTimeout',
      type: 'number',
      required: false,
      placeholder: '30000',
    },
  ],
  wxoa: [
    {
      key: 'appId',
      label: 'connFields.wxoaAppId',
      type: 'text',
      required: true,
      placeholder: 'connFields.wxoaAppIdHint',
    },
    {
      key: 'appSecret',
      label: 'connFields.wxoaAppSecret',
      type: 'password',
      required: true,
      placeholder: 'connFields.wxoaAppSecretHint',
    },
    {
      key: 'token',
      label: 'connFields.wxoaToken',
      type: 'password',
      required: true,
      placeholder: 'connFields.wxoaTokenHint',
    },
    {
      key: 'encodingAESKey',
      label: 'connFields.wxoaEncodingAESKey',
      type: 'password',
      required: false,
      placeholder: 'connFields.wxoaEncodingAESKeyHint',
    },
  ],
}

type ConfigField = {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'boolean'
  required: boolean
  placeholder?: string
}

const DB_COMMON_FIELDS: ConfigField[] = [
  {
    key: 'host',
    label: 'connFields.dbHost',
    type: 'text',
    required: true,
    placeholder: 'localhost',
  },
  { key: 'port', label: 'connFields.dbPort', type: 'number', required: true, placeholder: '5432' },
  {
    key: 'database',
    label: 'connFields.dbName',
    type: 'text',
    required: true,
    placeholder: 'mydb',
  },
  {
    key: 'username',
    label: 'connFields.dbUsername',
    type: 'text',
    required: true,
    placeholder: 'user',
  },
  {
    key: 'password',
    label: 'connFields.dbPassword',
    type: 'password',
    required: true,
    placeholder: 'connFields.dbPasswordHint',
  },
]

/** Configuration fields for each database subtype */
export const DATABASE_CONFIG_FIELDS_BY_SUBTYPE: Record<DatabaseSubtype, ConfigField[]> = {
  postgresql: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '5432',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'mydb',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'postgres',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  mysql: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '3306',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'mydb',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'root',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  mariadb: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '3306',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'mydb',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'root',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  sqlserver: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '1433',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'master',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'sa',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  oracle: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '1521',
    },
    {
      key: 'database',
      label: 'connFields.dbServiceName',
      type: 'text',
      required: true,
      placeholder: 'ORCL',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: true,
      placeholder: 'system',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: true,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  mongodb: [
    {
      key: 'connectionString',
      label: 'connFields.dbConnectionString',
      type: 'text',
      required: false,
      placeholder: 'mongodb://user:pass@host:27017/db',
    },
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: false,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: false,
      placeholder: '27017',
    },
    {
      key: 'database',
      label: 'connFields.dbName',
      type: 'text',
      required: true,
      placeholder: 'mydb',
    },
    {
      key: 'username',
      label: 'connFields.dbUsername',
      type: 'text',
      required: false,
      placeholder: 'user',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: false,
      placeholder: 'connFields.dbPasswordHint',
    },
  ],
  redis: [
    {
      key: 'host',
      label: 'connFields.dbHost',
      type: 'text',
      required: true,
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'connFields.dbPort',
      type: 'number',
      required: true,
      placeholder: '6379',
    },
    {
      key: 'password',
      label: 'connFields.dbPassword',
      type: 'password',
      required: false,
      placeholder: 'connFields.dbOptionalHint',
    },
    {
      key: 'database',
      label: 'connFields.dbIndex',
      type: 'number',
      required: false,
      placeholder: '0',
    },
  ],
}

/**
 * Get the display label for a database subtype from the connection config
 * Returns the specific name if dbType is present in config, otherwise null (caller provides fallback via t())
 */
export function getDatabaseDisplayLabel(config: Record<string, unknown>): string | null {
  const dbType = config?.dbType as DatabaseSubtype | undefined
  return dbType && DATABASE_SUBTYPE_LABELS[dbType] ? DATABASE_SUBTYPE_LABELS[dbType] : null
}

/**
 * Get the icon for a database subtype from the connection config
 */
export function getDatabaseDisplayIcon(config: Record<string, unknown>): string {
  const dbType = config?.dbType as DatabaseSubtype | undefined
  return dbType && DATABASE_SUBTYPE_ICONS[dbType] ? DATABASE_SUBTYPE_ICONS[dbType] : '🗄️'
}
