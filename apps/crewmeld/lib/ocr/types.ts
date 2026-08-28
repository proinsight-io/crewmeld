export type OcrInput =
  | { kind: 'image'; bytes: Uint8Array; mimeType: string }
  | { kind: 'pdf'; bytes: Uint8Array; mimeType: 'application/pdf'; page?: number }
  | { kind: 'url'; url: string }

export interface OcrResult {
  text: string
  lines: string[]
  lineCount: number
  logId?: number
}

export interface BaiduOcrConfig {
  apiKey: string
  secretKey: string
  endpoint?: string
  tokenEndpoint?: string
  timeoutMs?: number
}
