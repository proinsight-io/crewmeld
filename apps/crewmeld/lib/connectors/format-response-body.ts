/**
 * Format an HTTP response body string for human-readable display in the
 * connection test panel.
 *
 * - Valid JSON is pretty-printed with 2-space indentation.
 * - String values that are themselves JSON objects/arrays (a common
 *   double-encoding pattern, e.g. `{"message":"{\"a\":1}"}`) are recursively
 *   unwrapped so they render as nested structure instead of an escaped,
 *   `\n`-littered blob.
 * - Anything that is not JSON (HTML, plain text, empty body) is returned
 *   unchanged — not every response is JSON.
 */
export function formatResponseBody(raw: string): string {
  try {
    return JSON.stringify(deepParseJson(JSON.parse(raw)), null, 2)
  } catch {
    return raw
  }
}

/**
 * Recursively parse string values that are themselves JSON objects/arrays.
 * Only strings whose trimmed form starts with `{` or `[` are attempted, so
 * scalar-looking strings (`"123"`, `"true"`) are never coerced.
 */
function deepParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(deepParseJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = deepParseJson(v)
    return out
  }
  return value
}
