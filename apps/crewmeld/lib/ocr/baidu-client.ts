import type { BaiduOcrConfig, OcrInput, OcrResult } from './types'

const DEFAULT_TOKEN_ENDPOINT = 'https://aip.baidubce.com/oauth/2.0/token'
const DEFAULT_OCR_ENDPOINT = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic'
const DEFAULT_TIMEOUT_MS = 15_000

interface BaiduTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface BaiduOcrResponse {
  log_id?: number
  words_result_num?: number
  words_result?: Array<{ words?: string }>
  error_code?: number
  error_msg?: string
}

export class BaiduOcrError extends Error {
  constructor(
    message: string,
    readonly code?: number | string
  ) {
    super(message)
    this.name = 'BaiduOcrError'
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export async function getBaiduOcrAccessToken(config: BaiduOcrConfig): Promise<string> {
  const url = new URL(config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT)
  url.searchParams.set('grant_type', 'client_credentials')
  url.searchParams.set('client_id', config.apiKey)
  url.searchParams.set('client_secret', config.secretKey)

  const response = await fetchWithTimeout(
    url.toString(),
    { method: 'POST' },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
  const payload = (await response.json()) as BaiduTokenResponse
  if (!response.ok || !payload.access_token) {
    throw new BaiduOcrError(
      payload.error_description ?? payload.error ?? `Token request failed (${response.status})`,
      payload.error
    )
  }
  return payload.access_token
}

function createRequestBody(input: OcrInput): URLSearchParams {
  const body = new URLSearchParams({ language_type: 'CHN_ENG', detect_direction: 'true' })
  if (input.kind === 'image') body.set('image', Buffer.from(input.bytes).toString('base64'))
  if (input.kind === 'pdf') {
    body.set('pdf_file', Buffer.from(input.bytes).toString('base64'))
    if (input.page) body.set('pdf_file_num', String(input.page))
  }
  if (input.kind === 'url') {
    const url = new URL(input.url)
    if (url.protocol !== 'https:') throw new BaiduOcrError('OCR URL must use HTTPS')
    body.set('url', url.toString())
  }
  return body
}

export async function recognizeWithBaiduOcr(
  input: OcrInput,
  config: BaiduOcrConfig
): Promise<OcrResult> {
  const accessToken = await getBaiduOcrAccessToken(config)
  const endpoint = new URL(config.endpoint ?? DEFAULT_OCR_ENDPOINT)
  endpoint.searchParams.set('access_token', accessToken)
  const response = await fetchWithTimeout(
    endpoint.toString(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createRequestBody(input),
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
  const payload = (await response.json()) as BaiduOcrResponse
  if (!response.ok || payload.error_code) {
    throw new BaiduOcrError('Baidu OCR request failed', 'BAIDU_OCR_UPSTREAM_ERROR')
  }
  const lines = (payload.words_result ?? []).map((item) => item.words?.trim() ?? '').filter(Boolean)
  return {
    text: lines.join('\n'),
    lines,
    lineCount: payload.words_result_num ?? lines.length,
    logId: payload.log_id,
  }
}
