/**
 * UUID v4 that works in non-secure browser contexts.
 *
 * `crypto.randomUUID` is only exposed in *secure* contexts (HTTPS or localhost),
 * so a production build served over plain HTTP throws
 * "crypto.randomUUID is not a function". This helper prefers the native API,
 * then falls back to `crypto.getRandomValues` (available even in non-secure
 * contexts), and finally to `Math.random` as a last resort.
 *
 * Use this anywhere client-side code needs an id. Server code may keep using
 * `node:crypto` `randomUUID` directly (always available on the server).
 */
export function safeRandomUUID(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()

  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  // Set the RFC 4122 version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
