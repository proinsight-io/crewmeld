/**
 * Header forwarding policy for the external tool-invoke endpoint
 * (`POST /api/tools/[instanceId]/invoke`).
 *
 * The caller's inbound HTTP headers are made available to the invoked tool:
 *   - web-service tools: proxied onto the outbound request to the backend
 *   - script tools: injected into the container stdin as `_headers`
 *   - API tools: exposed as `ctx.headers` and overlaid on the outbound request
 *
 * This module centralizes which inbound headers are NOT forwarded.
 */

/**
 * Inbound headers that must never reach a tool backend:
 *   - `x-api-key` — the platform auth secret; forwarding would leak it.
 *   - `x-identity` — the platform identity convention; forwarding a
 *     caller-supplied value would let an external caller spoof identity to the
 *     downstream (the forwardIdentity path sets this itself).
 *   - `open-sandbox-api-key` — the OpenSandbox credential; the proxy sets it.
 *   - `content-type` / `content-length` — controlled by the proxy/runner.
 *   - hop-by-hop / connection headers — only meaningful for the caller↔platform
 *     hop; `accept-encoding` is left to the outbound `fetch` to manage.
 */
export const NON_FORWARDABLE_HEADERS: ReadonlySet<string> = new Set([
  'x-api-key',
  'x-identity',
  'open-sandbox-api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'accept-encoding',
])

/**
 * Project inbound request headers to the forwardable subset.
 *
 * @param headers - The inbound request `Headers` (keys are lowercased by the
 *   Headers API, so the returned map is keyed lowercase).
 * @returns A plain object of the headers safe to forward to a tool backend.
 */
export function forwardableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (!NON_FORWARDABLE_HEADERS.has(key.toLowerCase())) {
      out[key] = value
    }
  })
  return out
}
