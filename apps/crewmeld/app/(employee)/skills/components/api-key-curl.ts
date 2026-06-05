/**
 * Shared helpers for rendering a realistic `curl` example against a published
 * tool's invoke endpoint. Used by the API key panel (with a placeholder key)
 * and by the create dialog (with the real, freshly-minted key).
 */

interface JsonSchemaProp {
  type?: string
  default?: unknown
  description?: string
  enum?: unknown[]
}

/** Tool input JSON Schema subset consumed by the example builders. */
export interface ToolParameters {
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
}

/** Generate a realistic example value for a single JSON Schema property. */
function exampleFor(prop: JsonSchemaProp | undefined): unknown {
  if (!prop) return 'value'
  if (prop.default !== undefined && prop.default !== null) return prop.default
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0]
  switch (prop.type) {
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return 'text'
  }
}

/** Build an example input object from a JSON Schema, respecting required+defaults. */
export function buildInputExample(
  parameters: ToolParameters | null | undefined
): Record<string, unknown> {
  const props = parameters?.properties
  if (!props || Object.keys(props).length === 0) {
    return { param1: 'value1' }
  }
  const required = new Set(parameters?.required ?? [])
  const out: Record<string, unknown> = {}
  // Prefer required fields; if none marked required, include all properties.
  const keys =
    required.size > 0 ? Object.keys(props).filter((k) => required.has(k)) : Object.keys(props)
  for (const k of keys) out[k] = exampleFor(props[k])
  return out
}

/**
 * Build a `curl` command string for the invoke endpoint.
 *
 * @param endpoint - Full invoke URL.
 * @param parameters - Tool input JSON Schema, used to synthesize a realistic body.
 * @param apiKey - Value placed in the `X-API-Key` header — a placeholder like
 *   `YOUR_API_KEY` for the docs panel, or a real key right after creation.
 */
export function buildCurlExample(opts: {
  endpoint: string
  parameters: ToolParameters | null | undefined
  apiKey: string
}): string {
  const { endpoint, parameters, apiKey } = opts
  const inputExample = buildInputExample(parameters)
  // bash-escape single quotes inside the JSON for the curl -d argument
  const inputJson = JSON.stringify({ input: inputExample }).replace(/'/g, "'\\''")
  return `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${apiKey}" \\
  -d '${inputJson}'`
}
