import { createLogger } from '@crewmeld/logger'
import type { ApiCallParams, ApiCallResult } from '@/lib/tools/api-tool-types'
import type { ConnectionConfig } from './types'

const logger = createLogger('CallCustomApi')

/**
 * Execute a custom_api connection call, layering runtime params (query / headers /
 * body / path params) on top of the stored connection config. Shared by the
 * connection tester and the API-tool runtime (ctx.callApi).
 */
export async function callCustomApi(
  config: ConnectionConfig,
  params: ApiCallParams = {}
): Promise<ApiCallResult> {
  if (!config.apiEndpoint) {
    throw new Error('custom_api connection missing apiEndpoint')
  }

  // Resolve path params (e.g. /items/{id}) from runtime overrides.
  let endpoint = config.apiEndpoint
  if (params.pathParams) {
    for (const [k, v] of Object.entries(params.pathParams)) {
      endpoint = endpoint.replace(`{${k}}`, encodeURIComponent(v))
    }
  }

  const url = new URL(endpoint)
  if (Array.isArray(config.params)) {
    for (const p of config.params) {
      if (p.enabled && p.key?.trim()) url.searchParams.append(p.key, p.value ?? '')
    }
  }
  if (params.query) {
    for (const [k, v] of Object.entries(params.query)) url.searchParams.set(k, v)
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
    const encoded = Buffer.from(
      `${config.basicUsername}:${config.basicPassword ?? ''}`
    ).toString('base64')
    headers.Authorization = `Basic ${encoded}`
  }

  if (params.headers) Object.assign(headers, params.headers)

  const method = (config.httpMethod ?? 'GET').toUpperCase()

  let body: string | undefined
  if (params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body)
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json'
    }
  } else if (
    config.bodyType &&
    config.bodyType !== 'none' &&
    config.bodyContent &&
    method !== 'GET' &&
    method !== 'HEAD'
  ) {
    body = config.bodyContent
    if (config.bodyType === 'json' && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json'
    } else if (
      config.bodyType === 'form-urlencoded' &&
      !headers['Content-Type'] &&
      !headers['content-type']
    ) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    logger.error('custom_api call failed', {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  const text = await res.text()
  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    resHeaders[k] = v
  })

  const contentType = resHeaders['content-type'] ?? ''
  let parsed: unknown = text
  if (contentType.includes('application/json')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  return { status: res.status, statusText: res.statusText, headers: resHeaders, body: parsed }
}
