import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Prefix applied to every generated API key. */
export const API_KEY_PREFIX = 'cmk_' as const

/**
 * Generate a new API key.
 *
 * Format: `cmk_` + 48 lowercase hex characters (24 random bytes).
 * Total length: 52 characters.
 */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(24).toString('hex')
}

/**
 * Compute a SHA-256 HMAC of `plaintext` using the secret from
 * `process.env.API_KEY_HMAC_SECRET` (fallback: `'crewmeld-api-key-secret'`).
 *
 * @returns 64-character lowercase hex string.
 */
export function hashApiKey(plaintext: string): string {
  const secret = process.env['API_KEY_HMAC_SECRET'] ?? 'crewmeld-api-key-secret'
  return createHmac('sha256', secret).update(plaintext).digest('hex')
}

/**
 * Verify that `plaintext` matches `storedHash`.
 *
 * Uses a timing-safe comparison to prevent timing attacks.
 *
 * @returns `true` when the hashes match, `false` otherwise.
 */
export function verifyApiKey(plaintext: string, storedHash: string): boolean {
  const candidateHash = hashApiKey(plaintext)
  // Both buffers must be the same length for timingSafeEqual.
  // hashApiKey always returns a 64-char hex string, so this is guaranteed.
  try {
    return timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'))
  } catch {
    // If storedHash is malformed (wrong length) return false rather than throwing.
    return false
  }
}

/**
 * Return the first 12 characters of a key as a displayable prefix.
 *
 * Example: `cmk_a1b2c3d4` (useful for UIs that show "last used key").
 */
export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, 12)
}
