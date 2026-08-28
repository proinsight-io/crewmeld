import type { ServiceSseEvent } from './service-test-result'

const DEFAULT_MAX_EVENTS = 50
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5_000

export interface SseSampleOptions {
  maxEvents?: number
  maxDecodedBytes?: number
  timeoutMs?: number
  onEvent?: (event: ServiceSseEvent, index: number) => void
}

export interface SseSampleResult {
  events: ServiceSseEvent[]
  rawBody: string
  truncated: boolean
}

function parseFrame(frame: string): ServiceSseEvent | null {
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') data.push(value)
    if (field === 'event') event = value || undefined
    if (field === 'id' && !value.includes('\0')) id = value
    if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  if (data.length === 0) return null
  return {
    ...(event ? { event } : {}),
    data: data.join('\n'),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  }
}

function utf8Prefix(text: string, maxBytes: number): { value: string; complete: boolean } {
  if (maxBytes <= 0) return { value: '', complete: text.length === 0 }
  const encoder = new TextEncoder()
  let value = ''
  let used = 0
  for (const character of text) {
    const size = encoder.encode(character).byteLength
    if (used + size > maxBytes) return { value, complete: false }
    value += character
    used += size
  }
  return { value, complete: true }
}

/** Sample an SSE response while enforcing event, byte, and duration limits. */
export async function sampleSseStream(
  response: Response,
  options: SseSampleOptions = {}
): Promise<SseSampleResult> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const maxDecodedBytes = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reader = response.body?.getReader()
  if (!reader) return { events: [], rawBody: '', truncated: false }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const events: ServiceSseEvent[] = []
  let rawBody = ''
  let parseBuffer = ''
  let decodedBytes = 0
  let truncated = false
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  const consumeFrames = (flush: boolean): boolean => {
    while (events.length < maxEvents) {
      const separator = parseBuffer.match(/\r?\n\r?\n/)
      if (!separator || separator.index === undefined) break
      const frame = parseBuffer.slice(0, separator.index)
      parseBuffer = parseBuffer.slice(separator.index + separator[0].length)
      const parsed = parseFrame(frame)
      if (parsed) {
        const index = events.length
        events.push(parsed)
        options.onEvent?.(parsed, index)
      }
    }
    if (flush && events.length < maxEvents && parseBuffer.length > 0) {
      const parsed = parseFrame(parseBuffer)
      parseBuffer = ''
      if (parsed) {
        const index = events.length
        events.push(parsed)
        options.onEvent?.(parsed, index)
      }
    }
    return events.length >= maxEvents
  }

  const appendText = (text: string): boolean => {
    const remaining = maxDecodedBytes - decodedBytes
    const prefix = utf8Prefix(text, remaining)
    rawBody += prefix.value
    parseBuffer += prefix.value
    decodedBytes += encoder.encode(prefix.value).byteLength
    return !prefix.complete || decodedBytes >= maxDecodedBytes
  }

  try {
    while (!truncated) {
      const readResult = await Promise.race([reader.read(), timeout])
      if (readResult === 'timeout') {
        timedOut = true
        truncated = true
        break
      }
      if (readResult.done) {
        appendText(decoder.decode())
        consumeFrames(true)
        break
      }
      const reachedByteLimit = appendText(decoder.decode(readResult.value, { stream: true }))
      const reachedEventLimit = consumeFrames(false)
      truncated = reachedByteLimit || reachedEventLimit
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (truncated || timedOut) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  return { events, rawBody, truncated }
}
