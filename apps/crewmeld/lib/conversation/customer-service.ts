/** Customer-service conversation helpers. */

export interface CustomerServiceConfig {
  customerService?: boolean
  trackUnansweredQuestions?: boolean
  greeting?: string
  ocrProvider?: 'model' | 'baidu_ocr'
  ocrModelId?: string
  ocrConnectionId?: string
  ocrAllowedDomains?: string[]
}

/** Read the optional customer-service settings stored in digital employee config. */
export function getCustomerServiceConfig(config: unknown): CustomerServiceConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const value = config as Record<string, unknown>
  return {
    customerService: value.customerService === true,
    trackUnansweredQuestions: value.trackUnansweredQuestions === true,
    greeting: typeof value.greeting === 'string' ? value.greeting : undefined,
    ocrProvider:
      value.ocrProvider === 'baidu_ocr' || value.ocrProvider === 'model'
        ? value.ocrProvider
        : undefined,
    ocrModelId: typeof value.ocrModelId === 'string' ? value.ocrModelId : undefined,
    ocrConnectionId: typeof value.ocrConnectionId === 'string' ? value.ocrConnectionId : undefined,
    ocrAllowedDomains: Array.isArray(value.ocrAllowedDomains)
      ? value.ocrAllowedDomains.filter((item): item is string => typeof item === 'string')
      : undefined,
  }
}

/** Replace {{user.field}} placeholders without exposing undefined values. */
export function renderGreeting(template: string, user: Record<string, unknown>): string {
  return template.replace(/\{\{\s*user\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[key]
    }, user)
    return value === null || value === undefined ? '' : String(value)
  })
}

/** Prompt hint used when an attachment needs OCR/vision interpretation. */
export function buildAttachmentInstruction(fileNames: string[], hasText: boolean): string {
  const files = fileNames.join(', ')
  if (hasText)
    return `\n附件已上传（${files}）。请先结合附件内容理解用户意图，再回答；若无法确定意图，请先向用户提问。`
  return `请先识别附件（${files}）中的文字、表格或图示并判断用户意图；若意图不明确，请先向用户提问，不要编造答案。`
}
