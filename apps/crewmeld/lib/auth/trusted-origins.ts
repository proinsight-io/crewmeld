import { env } from '@/lib/core/config/env'

/**
 * Resolves better-auth's trusted origins (its CSRF / origin check), unified with
 * the CORS policy so a single `ALLOWED_ORIGINS` env var governs both layers.
 *
 * better-auth always trusts the configured `baseURL` origin on top of whatever
 * this returns, so the canonical URL never needs to be listed here.
 *
 * - `ALLOWED_ORIGINS='*'`        → trust any origin (wildcard), matching the CORS `*` mode
 * - `ALLOWED_ORIGINS='a,b'`      → trust exactly those origins
 * - empty / unset                → no extra origins (only the canonical `baseURL` is trusted)
 *
 * `NEXT_PUBLIC_SOCKET_URL`, when set, is always trusted for realtime connections.
 *
 * @remarks
 * The `*` wildcard relaxes origin-based CSRF protection for auth the same way
 * `ALLOWED_ORIGINS='*'` relaxes CORS — both express the deliberate "any origin"
 * deployment choice. Tighten by setting an explicit whitelist, which narrows
 * both CORS and this check at once.
 */
export function resolveAuthTrustedOrigins(): string[] {
  const socket = env.NEXT_PUBLIC_SOCKET_URL ? [env.NEXT_PUBLIC_SOCKET_URL] : []
  const configured = env.ALLOWED_ORIGINS?.trim()

  if (configured === '*') {
    return ['*', ...socket]
  }

  if (configured) {
    return [
      ...configured
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      ...socket,
    ]
  }

  return socket
}
