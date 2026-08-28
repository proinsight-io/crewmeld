import { createLogger } from '@crewmeld/logger'
import { resolveCredentialById } from '@/lib/connectors/resolver'
import { secureFetchWithValidation } from '@/lib/core/security/input-validation.server'
import { recognizeWithBaiduOcr } from '@/lib/ocr/baidu-client'
import type { BaiduOcrConfig, OcrInput } from '@/lib/ocr/types'
import { getCustomerServiceConfig } from './customer-service'
import { type FileAttachment, readConversationFileBytes } from './file-storage'
import { resolveModelConfig } from './model-config'
import type { ConversationModelConfig } from './types'

const logger = createLogger('ConversationOcr')
const MAX_OCR_BYTES = 5 * 1024 * 1024
const OCR_URL_PATTERN = /https:\/\/[^\s<>'"，。；！？、）)]+/giu

interface PrepareOcrContextInput {
  message: string
  files?: FileAttachment[]
  employeeId: string
  workspaceId: string
  employeeConfig: unknown
}

interface DownloadedOcrDocument {
  bytes: Uint8Array
  mimeType: string
  label: string
}

/** Extract only image and PDF HTTPS links so ordinary links do not trigger OCR. */
export function extractOcrDocumentUrls(message: string): string[] {
  const matches = message.match(OCR_URL_PATTERN) ?? []
  return [...new Set(matches)].filter((candidate) => {
    try {
      return /\.(?:png|jpe?g|bmp|webp|pdf)$/i.test(new URL(candidate).pathname)
    } catch {
      return false
    }
  })
}

/** Empty domain lists allow any URL that passes the SSRF-safe downloader. */
export function isOcrUrlAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    return pattern.startsWith('*.')
      ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
      : hostname === pattern
  })
}

async function downloadOcrDocument(url: string): Promise<DownloadedOcrDocument> {
  const response = await secureFetchWithValidation(
    url,
    { timeout: 15_000, maxRedirects: 3, maxResponseBytes: MAX_OCR_BYTES },
    'ocrDocumentUrl'
  )
  if (!response.ok) throw new Error(`OCR document download failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headerType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const extensionIsPdf = new URL(url).pathname.toLowerCase().endsWith('.pdf')
  const mimeType = headerType || (extensionIsPdf ? 'application/pdf' : 'image/jpeg')
  if (mimeType !== 'application/pdf' && !mimeType.startsWith('image/')) {
    throw new Error(`Unsupported OCR document type: ${mimeType}`)
  }
  return { bytes, mimeType, label: url }
}

async function loadUploadedDocuments(files: FileAttachment[]): Promise<DownloadedOcrDocument[]> {
  const documents: DownloadedOcrDocument[] = []
  for (const file of files) {
    if (file.mimeType !== 'application/pdf' && !file.mimeType.startsWith('image/')) continue
    const bytes = await readConversationFileBytes(file.key, MAX_OCR_BYTES)
    if (bytes) documents.push({ bytes, mimeType: file.mimeType, label: file.name })
  }
  return documents
}

function toOcrInput(document: DownloadedOcrDocument): OcrInput {
  return document.mimeType === 'application/pdf'
    ? { kind: 'pdf', bytes: document.bytes, mimeType: 'application/pdf' }
    : { kind: 'image', bytes: document.bytes, mimeType: document.mimeType }
}

async function resolveBaiduConfig(connectionId: string): Promise<BaiduOcrConfig> {
  const credential = await resolveCredentialById(connectionId)
  if (!credential || credential.type !== 'baidu_ocr') {
    throw new Error('Configured Baidu OCR connection is unavailable')
  }
  const { config } = credential
  if (!config.baiduOcrApiKey || !config.baiduOcrSecretKey) {
    throw new Error('Configured Baidu OCR credentials are incomplete')
  }
  return {
    apiKey: config.baiduOcrApiKey,
    secretKey: config.baiduOcrSecretKey,
    endpoint: config.baiduOcrEndpoint,
    tokenEndpoint: config.baiduOcrTokenEndpoint,
    timeoutMs: config.baiduOcrTimeoutMs,
  }
}

async function recognizeWithVisionModel(
  model: ConversationModelConfig,
  document: DownloadedOcrDocument
): Promise<string> {
  if (document.mimeType === 'application/pdf') {
    return '该 OCR 大模型通道不支持直接读取 PDF，请改用百度智能云 OCR。'
  }
  const dataUrl = `data:${document.mimeType};base64,${Buffer.from(document.bytes).toString('base64')}`
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请准确提取图片中的文字、表格和关键图示信息，只返回识别内容。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`OCR model request failed (${response.status})`)
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return payload.choices?.[0]?.message?.content?.trim() ?? ''
}

/** Resolve and recognize uploaded or linked documents before intent routing and retrieval. */
export async function prepareOcrContext(input: PrepareOcrContextInput): Promise<string> {
  const settings = getCustomerServiceConfig(input.employeeConfig)
  const urls = extractOcrDocumentUrls(input.message).filter((url) =>
    isOcrUrlAllowed(url, settings.ocrAllowedDomains ?? [])
  )
  if ((!input.files || input.files.length === 0) && urls.length === 0) return ''

  const documents = await loadUploadedDocuments(input.files ?? [])
  for (const url of urls) {
    try {
      documents.push(await downloadOcrDocument(url))
    } catch (error) {
      logger.warn('Linked OCR document download failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (documents.length === 0) return ''

  const recognized: string[] = []
  if (settings.ocrProvider === 'baidu_ocr' && settings.ocrConnectionId) {
    const config = await resolveBaiduConfig(settings.ocrConnectionId)
    for (const document of documents) {
      const result = await recognizeWithBaiduOcr(toOcrInput(document), config)
      if (result.text) recognized.push(`【${document.label}】\n${result.text}`)
    }
  } else {
    const model = await resolveModelConfig(input.employeeId, input.workspaceId, settings.ocrModelId)
    for (const document of documents) {
      const text = await recognizeWithVisionModel(model, document)
      if (text) recognized.push(`【${document.label}】\n${text}`)
    }
  }

  return recognized.length > 0
    ? `\n\n[OCR识别内容]\n${recognized.join('\n\n')}\n[OCR识别内容结束]`
    : ''
}
