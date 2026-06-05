import { createLogger } from '@crewmeld/logger'
import { proxyFetch } from '@/lib/channels/proxy-fetch'
import type { ConnectionConfig, ConnectionTestResult, ConnectionType } from './types'

const logger = createLogger('ConnectionTester')

/**
 * Test connection availability.
 * Returns a structured result with i18n key + params (no pre-localized string).
 * Frontend renders via useTranslation against `connHealth.{key}`.
 */
export async function testConnection(
  type: ConnectionType,
  config: ConnectionConfig
): Promise<ConnectionTestResult> {
  const startTime = Date.now()

  try {
    switch (type) {
      case 'wecom':
        return await testWecom(config, startTime)
      case 'dingtalk':
        return await testDingtalk(config, startTime)
      case 'feishu':
        return await testFeishu(config, startTime)
      case 'crm':
        return await testCrmApi(config, startTime)
      case 'database':
        return await testDatabase(config, startTime)
      case 'custom_api':
        return await testCustomApi(config, startTime)
      case 'n8n':
        return await testN8n(config, startTime)
      case 'openclaw':
        return await testOpenclaw(config, startTime)
      case 'email':
        return await testEmail(config, startTime)
      case 'telegram':
        return await testTelegram(config, startTime)
      case 'discord':
        return await testDiscord(config, startTime)
      case 'ragflow':
        return await testRagflow(config, startTime)
      case 'wxoa':
        return await testWxoa(config, startTime)
      default:
        return fail('connTestUnsupportedType', { type }, startTime)
    }
  } catch (error) {
    logger.error(`Connection test failed: type=${type}`, error)
    return fail(
      'connTestFailed',
      { name: type, error: error instanceof Error ? error.message : '' },
      startTime
    )
  }
}

// ── Result builders ───────────────────────────────────────────────

function ok(
  key: string,
  params: Record<string, string> | undefined,
  startTime: number,
  details?: Record<string, string>
): ConnectionTestResult {
  return {
    success: true,
    messageKey: key,
    messageParams: params,
    latencyMs: Date.now() - startTime,
    details,
  }
}

function fail(
  key: string,
  params: Record<string, string> | undefined,
  startTime: number,
  details?: Record<string, string>
): ConnectionTestResult {
  return {
    success: false,
    messageKey: key,
    messageParams: params,
    latencyMs: Date.now() - startTime,
    details,
  }
}

function required(fields: string, startTime: number): ConnectionTestResult {
  return fail('connTestFieldsRequired', { fields }, startTime)
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

// ── Individual testers ────────────────────────────────────────────

async function testWecom(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.corpId || !config.corpSecret) return required('Corp ID & Corp Secret', startTime)

  try {
    const { getWeComAccessToken } = await import('@/lib/channels/wecom/auth')
    await getWeComAccessToken(config.corpId, config.corpSecret)
    return ok('connTestSucceeded', { name: 'WeCom' }, startTime, {
      api: 'qyapi.weixin.qq.com',
      method: 'gettoken',
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'WeCom', error: errMsg(error) }, startTime)
  }
}

async function testDingtalk(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.appKey || !config.appSecret) return required('App Key & App Secret', startTime)
  await simulateDelay(200, 600)
  return ok('connTestSucceeded', { name: 'DingTalk' }, startTime, {
    api: 'oapi.dingtalk.com',
    method: 'gettoken',
  })
}

async function testFeishu(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.appId || !config.appSecret) return required('App ID & App Secret', startTime)
  await simulateDelay(200, 600)
  return ok('connTestSucceeded', { name: 'Feishu' }, startTime, {
    api: 'open.feishu.cn',
    method: 'tenant_access_token',
  })
}

async function testDiscord(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.botToken) return required('Bot Token', startTime)

  try {
    const { discordFetch } = await import('@/lib/channels/plugins/discord/fetch')
    const res = await discordFetch('/users/@me', config.botToken)

    if (!res.ok) {
      return fail(
        'connTestApiReturned',
        { name: 'Discord', status: String(res.status), body: res.body },
        startTime
      )
    }

    const data = res.json<Record<string, string>>()
    const proxy = process.env.HTTPS_PROXY
    return ok('connTestSucceeded', { name: 'Discord' }, startTime, {
      username: `${data.username}${data.discriminator ? `#${data.discriminator}` : ''}`,
      id: data.id,
      proxy: proxy ?? '__direct__',
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'Discord', error: errMsg(error) }, startTime)
  }
}

async function testCrmApi(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.apiEndpoint) return required('API URL', startTime)
  await simulateDelay(300, 800)
  return ok('connTestSucceeded', { name: 'CRM' }, startTime, { endpoint: config.apiEndpoint })
}

async function testDatabase(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  const dbType = config.dbType ?? 'mysql'

  if (dbType === 'redis') {
    if (!config.host) return required('Redis host', startTime)
    return testRedisConnection(config, startTime)
  }

  if (dbType === 'mongodb') {
    if (!config.connectionString && !config.host)
      return required('MongoDB host or connection string', startTime)
    return testMongoConnection(config, startTime)
  }

  if (!config.host || !config.database) return required('host & database', startTime)

  switch (dbType) {
    case 'mysql':
    case 'mariadb':
      return testMysqlConnection(config, startTime)
    case 'postgresql':
      return testPostgresConnection(config, startTime)
    case 'sqlserver':
    case 'oracle':
      return testTcpConnection(config, startTime, dbType)
    default:
      return testTcpConnection(config, startTime, dbType)
  }
}

async function testMysqlConnection(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  try {
    const mysql = await import('mysql2/promise')
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port ?? 3306,
      user: config.username,
      password: config.password,
      database: config.database,
      connectTimeout: 10000,
      ssl: config.ssl ? {} : undefined,
    })
    await conn.ping()
    await conn.end()
    return ok('connTestSucceeded', { name: 'MySQL' }, startTime, {
      host: config.host!,
      port: String(config.port ?? 3306),
      database: config.database!,
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'MySQL', error: errMsg(error) }, startTime)
  }
}

async function testPostgresConnection(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  try {
    const postgres = (await import('postgres')).default
    const sql = postgres({
      host: config.host,
      port: config.port ?? 5432,
      username: config.username,
      password: config.password,
      database: config.database,
      connect_timeout: 10,
      ssl: config.ssl ? 'require' : undefined,
      max: 1,
    })
    await sql`SELECT 1`
    await sql.end()
    return ok('connTestSucceeded', { name: 'PostgreSQL' }, startTime, {
      host: config.host!,
      port: String(config.port ?? 5432),
      database: config.database!,
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'PostgreSQL', error: errMsg(error) }, startTime)
  }
}

async function testMongoConnection(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  try {
    const { MongoClient } = await import('mongodb')
    const uri =
      config.connectionString ??
      `mongodb://${config.username ? `${config.username}:${config.password}@` : ''}${config.host}:${config.port ?? 27017}/${config.database ?? ''}`
    const client = new MongoClient(uri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    })
    await client.connect()
    await client.db().command({ ping: 1 })
    await client.close()
    return ok('connTestSucceeded', { name: 'MongoDB' }, startTime, {
      host: config.host ?? '__connstring__',
      database: config.database ?? '',
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'MongoDB', error: errMsg(error) }, startTime)
  }
}

async function testRedisConnection(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  try {
    const Redis = (await import('ioredis')).default
    const redis = new Redis({
      host: config.host,
      port: config.port ?? 6379,
      password: config.password || undefined,
      db: config.database ? Number.parseInt(config.database, 10) || 0 : 0,
      connectTimeout: 10000,
      lazyConnect: true,
      tls: config.ssl ? {} : undefined,
    })
    await redis.connect()
    await redis.ping()
    await redis.quit()
    return ok('connTestSucceeded', { name: 'Redis' }, startTime, {
      host: config.host!,
      port: String(config.port ?? 6379),
    })
  } catch (error) {
    return fail('connTestFailed', { name: 'Redis', error: errMsg(error) }, startTime)
  }
}

async function testTcpConnection(
  config: ConnectionConfig,
  startTime: number,
  dbType: string
): Promise<ConnectionTestResult> {
  const net = await import('net')
  const port = config.port ?? (dbType === 'sqlserver' ? 1433 : dbType === 'oracle' ? 1521 : 3306)
  const label = dbType === 'sqlserver' ? 'SQL Server' : dbType === 'oracle' ? 'Oracle' : dbType
  const addr = `${config.host}:${port}`

  return new Promise((resolve) => {
    const socket = new net.Socket()
    const timeout = 10000

    socket.setTimeout(timeout)
    socket.on('connect', () => {
      socket.destroy()
      resolve(
        ok('connTestTcpSuccess', { label, addr }, startTime, {
          host: config.host!,
          port: String(port),
        })
      )
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(fail('connTestTcpTimeout', { label, addr }, startTime))
    })
    socket.on('error', (err) => {
      socket.destroy()
      resolve(fail('connTestFailed', { name: label, error: err.message }, startTime))
    })
    socket.connect(port, config.host!)
  })
}

async function testCustomApi(
  config: ConnectionConfig,
  startTime: number
): Promise<
  ConnectionTestResult & {
    response?: { status: number; statusText: string; body: string; headers: Record<string, string> }
  }
> {
  if (!config.apiEndpoint) return required('API URL', startTime)

  try {
    const url = new URL(config.apiEndpoint)
    if (Array.isArray(config.params)) {
      for (const p of config.params) {
        if (p.enabled && p.key?.trim()) url.searchParams.append(p.key, p.value ?? '')
      }
    }

    const headers: Record<string, string> = {}
    if (Array.isArray(config.customHeaders)) {
      for (const h of config.customHeaders) {
        if (h.enabled && h.key?.trim()) headers[h.key] = h.value ?? ''
      }
    }

    const authType = config.authType ?? 'none'
    if (authType === 'api_key' && config.apiKey) {
      headers['X-API-Key'] = config.apiKey
    } else if (authType === 'bearer' && config.bearerToken) {
      headers.Authorization = `Bearer ${config.bearerToken}`
    } else if (authType === 'basic' && config.basicUsername) {
      const encoded = Buffer.from(`${config.basicUsername}:${config.basicPassword ?? ''}`).toString(
        'base64'
      )
      headers.Authorization = `Basic ${encoded}`
    }

    const method = (config.httpMethod ?? 'GET').toUpperCase()
    let body: string | undefined
    const bodyType = config.bodyType ?? 'none'
    if (bodyType !== 'none' && config.bodyContent && method !== 'GET' && method !== 'HEAD') {
      body = config.bodyContent
      if (bodyType === 'json' && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json'
      } else if (
        bodyType === 'form-urlencoded' &&
        !headers['Content-Type'] &&
        !headers['content-type']
      ) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    }

    const fetchStart = Date.now()
    const res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const latencyMs = Date.now() - fetchStart
    const resBody = await res.text()
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      resHeaders[k] = v
    })

    const isOk = res.status >= 200 && res.status < 400
    const statusStr = `${res.status} ${res.statusText}`
    return {
      success: isOk,
      messageKey: isOk ? 'connTestRequestSuccess' : 'connTestRequestFailed',
      messageParams: { status: statusStr },
      latencyMs,
      details: {
        endpoint: config.apiEndpoint,
        method,
        status: `${res.status}`,
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        body: resBody,
        headers: resHeaders,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Custom API test error:', msg)
    return {
      ...fail('connTestFailed', { name: 'API', error: msg }, startTime),
      details: { endpoint: config.apiEndpoint ?? '' },
    }
  }
}

async function testEmail(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.smtpHost || !config.smtpPort || !config.username || !config.password)
    return required('SMTP host, port, username & password', startTime)

  const port = Number(config.smtpPort)
  const host = String(config.smtpHost)

  try {
    const nodemailer = (await import('nodemailer')).default
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: config.smtpSecure ?? port === 465,
      auth: { user: String(config.username), pass: String(config.password) },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
    await transporter.verify()
    return ok('connTestEmailSuccess', undefined, startTime, { host, port: String(port) })
  } catch (error) {
    const msg = errMsg(error)
    const code = (error as NodeJS.ErrnoException)?.code ?? ''
    // nodemailer responseCode 535 = auth failed; code EAUTH is also set
    const responseCode = (error as { responseCode?: number })?.responseCode
    if (code === 'EAUTH' || responseCode === 535) {
      return fail('connTestEmailAuthFailed', undefined, startTime)
    }
    if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
      return fail('connTestEmailTimeout', undefined, startTime)
    }
    if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ECONNRESET'
    ) {
      return fail('connTestEmailHostUnreachable', { host, code: code || 'unknown' }, startTime)
    }
    return fail('connTestFailed', { name: 'Email', error: msg }, startTime)
  }
}

async function testRagflow(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  const endpoint = config.ragflowEndpoint ?? config.apiEndpoint
  if (!endpoint || !config.apiKey) return required('Knowledge Base API URL & API Key', startTime)

  try {
    const { healthCheck } = await import('@/lib/ragflow/client')
    const { RagflowErrorType } = await import('@/lib/ragflow/errors')
    const result = await healthCheck({
      endpoint: endpoint.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      timeoutMs: config.ragflowTimeoutMs ?? 30_000,
    })

    if (!result.ok) {
      const keyByType: Record<string, string> = {
        [RagflowErrorType.AuthFailed]: 'connTestKbAuthFailed',
        [RagflowErrorType.NotFound]: 'connTestKbNotFound',
        [RagflowErrorType.Timeout]: 'connTestKbTimeout',
        [RagflowErrorType.ServerError]: 'connTestKbServerError',
        [RagflowErrorType.NetworkError]: 'connTestKbNetworkError',
        [RagflowErrorType.InvalidResponse]: 'connTestKbInvalidResponse',
        [RagflowErrorType.ConfigMissing]: 'connTestKbConfigInvalid',
        [RagflowErrorType.ConnectionFailed]: 'connTestKbConfigInvalid',
      }
      const key = keyByType[result.errorType] ?? 'connTestKbNetworkError'
      return fail(key, { detail: result.detail }, startTime)
    }

    return ok('connTestSucceeded', { name: 'Knowledge Base' }, startTime, { endpoint })
  } catch (error) {
    const msg = error instanceof Error ? error.message : '__knowledge_unreachable__'
    return fail('connTestFailed', { name: 'Knowledge Base', error: msg }, startTime)
  }
}

async function testN8n(config: ConnectionConfig, startTime: number): Promise<ConnectionTestResult> {
  if (!config.n8nBaseUrl || !config.n8nApiKey) return required('n8n API URL & API Key', startTime)

  try {
    const baseUrl = config.n8nBaseUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/api/v1/workflows?limit=1`, {
      method: 'GET',
      headers: { 'X-N8N-API-KEY': config.n8nApiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeout ?? 10_000),
    })

    if (!res.ok) {
      return fail('connTestFailed', { name: 'n8n', error: `HTTP ${res.status}` }, startTime)
    }

    return ok('connTestSucceeded', { name: 'n8n' }, startTime, { endpoint: baseUrl })
  } catch (error) {
    const msg = error instanceof Error ? error.message : '__gateway_unreachable__'
    return fail('connTestFailed', { name: 'n8n', error: msg }, startTime)
  }
}

async function testOpenclaw(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  const endpoints = config.endpoints ?? []
  if (endpoints.length === 0) {
    return required('endpoints', startTime)
  }

  const perEndpointTimeout = config.timeout ?? 10_000

  // Probe every endpoint in parallel so the user sees the full pool status
  // in one shot. Overall success requires every endpoint to come back ok.
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const httpUrl = ep.url
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/\/+$/, '')
      try {
        const res = await fetch(httpUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${ep.token}` },
          signal: AbortSignal.timeout(perEndpointTimeout),
        })
        return { label: ep.label, ok: true, detail: String(res.status) }
      } catch (error) {
        const msg = error instanceof Error ? error.message : '__gateway_unreachable__'
        return { label: ep.label, ok: false, detail: msg }
      }
    })
  )

  const details: Record<string, string> = {}
  for (const r of results) {
    details[r.label] = r.ok ? `OK ${r.detail}` : `FAIL ${r.detail}`
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    return ok('connTestSucceeded', { name: 'OpenClaw' }, startTime, details)
  }
  const errSummary = failed.map((r) => `${r.label}: ${r.detail}`).join('; ')
  return fail('connTestFailed', { name: 'OpenClaw', error: errSummary }, startTime, details)
}

async function testTelegram(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.telegramBotToken) {
    logger.warn('[Telegram] Bot token is empty, skipping test')
    return required('Bot Token', startTime)
  }

  const maskedToken = `${config.telegramBotToken.slice(0, 6)}***${config.telegramBotToken.slice(-4)}`
  const timeoutMs = config.timeout ?? 15_000
  const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/getMe`

  logger.info(`[Telegram] Starting connection test`, { maskedToken, timeoutMs })

  try {
    const fetchStart = Date.now()
    const res = await proxyFetch(apiUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const fetchMs = Date.now() - fetchStart
    logger.info(`[Telegram] Fetch completed`, { status: res.status, fetchMs })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '__unreadable__')
      return fail(
        'connTestTelegramVerifyFailed',
        { status: String(res.status), body: bodyText.slice(0, 200) },
        startTime
      )
    }

    const data = (await res.json()) as {
      ok: boolean
      result?: { username?: string; first_name?: string; id?: number }
    }
    if (!data.ok) {
      return fail('connTestTelegramInvalid', undefined, startTime)
    }

    return ok('connTestSucceeded', { name: 'Telegram Bot' }, startTime, {
      botUsername: `@${data.result?.username ?? 'unknown'}`,
    })
  } catch (error) {
    const elapsed = Date.now() - startTime
    const errName = error instanceof Error ? error.name : 'Unknown'
    const msg = error instanceof Error ? error.message : String(error)
    const errCode = (error as NodeJS.ErrnoException)?.code ?? ''
    logger.error(`[Telegram] Connection error`, { errName, errMsg: msg, errCode, elapsed })

    if (errName === 'TimeoutError' || errName === 'AbortError' || msg.includes('timeout')) {
      return fail(
        'connTestFailedTimeoutHint',
        { name: 'Telegram', error: msg, host: 'api.telegram.org' },
        startTime
      )
    }
    if (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET' || errCode === 'ENOTFOUND') {
      return fail(
        'connTestFailedNetworkHint',
        { name: 'Telegram', error: msg, code: errCode },
        startTime
      )
    }
    if (msg.includes('fetch failed')) {
      return fail('connTestFailedFetchHint', { name: 'Telegram', error: msg }, startTime)
    }
    return fail('connTestFailed', { name: 'Telegram', error: msg }, startTime)
  }
}

async function testWxoa(
  config: ConnectionConfig,
  startTime: number
): Promise<ConnectionTestResult> {
  if (!config.appId || !config.appSecret) return required('AppID & AppSecret', startTime)

  try {
    const { getWxoaAccessToken } = await import('@/lib/channels/wxoa-token')
    await getWxoaAccessToken(config.appId, config.appSecret)
    return ok('connTestWxoaSuccess', undefined, startTime, {
      api: 'api.weixin.qq.com',
      method: 'cgi-bin/token',
    })
  } catch (error) {
    return fail('connTestWxoaFailed', { error: errMsg(error) }, startTime)
  }
}

function simulateDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs)
  return new Promise((resolve) => setTimeout(resolve, delay))
}
