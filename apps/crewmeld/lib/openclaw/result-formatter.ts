/**
 * OpenClaw response payload shapes seen in the wild:
 *
 * - **OpenAI-compatible chat completion** (current `/v1/chat/completions` shape):
 *   `{ choices: [{ message: { role, content } }], ... }` — this is the official
 *   server-to-server integration response (preferred path).
 *
 * - **MCP envelope** (legacy `/tools/invoke` shape):
 *   `{ content: [{type, text}, ...], details: {...} }`
 *
 * - **Legacy `result` shape** (kept for back-compat, spike-era):
 *   `{ result: <string|object|array> }`
 *
 * - **Errors** — `{ error: { message, type } }` — handled upstream before
 *   reaching this formatter.
 */
export interface OpenclawResponse {
  /** OpenAI-style choices array (preferred). */
  choices?: unknown
  /** MCP-style content blocks. */
  content?: unknown
  /** MCP-style structured data fallback. */
  details?: unknown
  /** Legacy single-result envelope. */
  result?: unknown
  [key: string]: unknown
}

const EMPTY_SENTINEL = '_OpenClaw returned no result_'

/**
 * Format an OpenClaw success response into Markdown-ish text for conversation.
 *
 * Priority order:
 * 1. OpenAI-style `choices[].message.content` (or streaming `choices[].delta.content`)
 *    — the official `/v1/chat/completions` shape
 * 2. MCP envelope (legacy /tools/invoke): content array → text, or details fallback
 * 3. Legacy `result` field (string / object-with-message / array / object)
 * 4. Fallback → entire payload as JSON block, or empty-result sentinel
 *
 * Higher-priority branches handle empty-but-present data by returning the empty
 * sentinel (so a blank assistant reply renders as `_OpenClaw returned no result_` rather
 * than leaking the envelope downstream).
 */
export function formatOpenclawResult(payload: OpenclawResponse): string {
  if (payload === null || payload === undefined) return EMPTY_SENTINEL

  // 1) OpenAI chat completion: { choices: [{ message: {content} | delta: {content} }] }
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const text = extractOpenaiChoiceText(payload.choices)
    if (text !== '') return text
    return EMPTY_SENTINEL
  }

  // 2) MCP envelope: { content: [...], details?: ... }
  if (Array.isArray(payload.content)) {
    const text = extractMcpText(payload.content)
    if (text !== '') return renderTextOrJson(text)

    // Content array present but empty/non-text → try details
    if (payload.details !== undefined && payload.details !== null) {
      return wrapJson(payload.details)
    }
    return EMPTY_SENTINEL
  }

  // 3) Legacy `result` envelope
  if ('result' in payload) {
    return formatLegacyResult(payload)
  }

  // 4) Unknown shape → dump whole payload
  const keys = Object.keys(payload)
  if (keys.length === 0) return EMPTY_SENTINEL
  return wrapJson(payload)
}

/**
 * Pull assistant text out of an OpenAI chat-completion `choices` array.
 *
 * Reads `message.content` (non-streaming) first, then `delta.content`
 * (streaming/partial). Concatenates across choices on the rare chance the
 * gateway returns multiple — they almost always have a single choice in
 * practice. Empty/whitespace-only result returns `''` so the caller can fall
 * through to the empty-result sentinel.
 */
function extractOpenaiChoiceText(choices: unknown[]): string {
  const parts: string[] = []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const c = choice as Record<string, unknown>
    const message = c.message as { content?: unknown } | undefined
    const delta = c.delta as { content?: unknown } | undefined
    const content = message?.content ?? delta?.content
    if (typeof content === 'string' && content !== '') {
      parts.push(content)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * Pull `text`-typed entries out of an MCP content array and concatenate with
 * blank-line separators. Non-text entries (e.g. images) are skipped.
 */
function extractMcpText(content: unknown[]): string {
  const parts: string[] = []
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.type === 'text' && typeof e.text === 'string') {
      parts.push(e.text)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * If `text` is parseable as a JSON object or array, render as a fenced JSON
 * code block (pretty-printed). Otherwise return the text as-is.
 *
 * Why: OpenClaw frequently stuffs structured data into the `text` field as a
 * raw stringified JSON. Pretty-printing it inside a fence keeps it readable
 * and avoids dumping raw `\n`-escaped strings into chat bubbles.
 */
function renderTextOrJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') {
        return wrapJson(parsed)
      }
    } catch {
      // not JSON — fall through and return as-is
    }
  }
  return text
}

/** Legacy `{result: ...}` formatter, preserved for back-compat. */
function formatLegacyResult(payload: OpenclawResponse): string {
  const result = payload.result

  if (result === null || result === undefined) {
    const extraKeys = Object.keys(payload).filter((k) => k !== 'result')
    if (extraKeys.length === 0) return EMPTY_SENTINEL
    const extra: Record<string, unknown> = {}
    for (const k of extraKeys) extra[k] = payload[k]
    return wrapJson(extra)
  }

  if (typeof result === 'string') {
    return result.trim() !== '' ? result : EMPTY_SENTINEL
  }

  if (typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>
    if (typeof obj.message === 'string') {
      const rest: Record<string, unknown> = { ...obj }
      delete rest.message
      if (Object.keys(rest).length === 0) return obj.message
      return `${obj.message}\n\n${wrapJson(rest)}`
    }
  }

  return wrapJson(result)
}

/** Wrap a value in a fenced JSON code block. */
function wrapJson(value: unknown): string {
  try {
    return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
  } catch {
    return String(value)
  }
}
