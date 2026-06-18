/**
 * HMAC tokens authenticating async-tool completion callbacks.
 *
 * When the BFF dispatches an async tool it assembles a callback URL and a token
 * bound to (executionId, callId). The tool's platform wrapper POSTs the result
 * back with that token; the callback route recomputes the HMAC and rejects any
 * mismatch. This stops an attacker who guesses an executionId/callId from
 * waking or poisoning a suspended SOP, without needing a session or a DB lookup
 * to validate the caller.
 *
 * The signing secret comes from CREWMELD_SANDBOX_CALLBACK_SECRET; in its absence
 * we fall back to an existing secret (INTERNAL_API_SECRET → BETTER_AUTH_SECRET →
 * AUTH_SECRET) so a standard deployment works without extra config. Tokens carry
 * no expiry of their own — the SOP's watchdog bounds how long a callback can be
 * honored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Resolve the signing secret, preferring the dedicated var and falling back to
 * an existing always-present secret so async tools work without extra config:
 * INTERNAL_API_SECRET (purpose-built for internal API calls — the callback is
 * one) → BETTER_AUTH_SECRET (this project's canonical auth/signing secret) →
 * AUTH_SECRET (legacy).
 */
function callbackSecret(): string {
  const secret =
    process.env.CREWMELD_SANDBOX_CALLBACK_SECRET ??
    process.env.INTERNAL_API_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET
  if (!secret) {
    throw new Error(
      'Async tool callbacks require CREWMELD_SANDBOX_CALLBACK_SECRET (or INTERNAL_API_SECRET / BETTER_AUTH_SECRET) to be set.'
    )
  }
  return secret
}

/** Deterministic message signed for a given suspended tool call. */
function payload(executionId: string, callId: string): string {
  return `${executionId}:${callId}`
}

/** Sign a callback token for (executionId, callId). Hex-encoded HMAC-SHA256. */
export function signCallbackToken(executionId: string, callId: string): string {
  return createHmac('sha256', callbackSecret()).update(payload(executionId, callId)).digest('hex')
}

/**
 * Verify a presented token against (executionId, callId) in constant time.
 * Returns false on any malformed input rather than throwing, so the callback
 * route can treat all failures as a uniform 401/403.
 */
export function verifyCallbackToken(
  executionId: string,
  callId: string,
  presented: string | null | undefined
): boolean {
  if (!presented) return false
  let expected: string
  try {
    expected = signCallbackToken(executionId, callId)
  } catch {
    return false
  }
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(presented, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}
