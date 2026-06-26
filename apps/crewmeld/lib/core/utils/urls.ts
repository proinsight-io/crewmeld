import { getEnv } from '@/lib/core/config/env'
import { isProd } from '@/lib/core/config/feature-flags'

function hasHttpProtocol(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function normalizeBaseUrl(url: string): string {
  if (hasHttpProtocol(url)) {
    return url
  }

  const protocol = isProd ? 'https://' : 'http://'
  return `${protocol}${url}`
}

/**
 * Returns the base URL of the application.
 * Resolution order: APP_BASE_URL (optional server-side override) > NEXT_PUBLIC_APP_URL.
 * @returns The base URL string (e.g., 'http://localhost:6100' or 'https://example.com')
 * @throws Error if no base URL is configured
 */
export function getBaseUrl(): string {
  // APP_BASE_URL is a server-only override. It MUST be read via process.env, not getEnv:
  // next-runtime-env's env() throws for any non-NEXT_PUBLIC_ key in the browser, so routing
  // APP_BASE_URL through getEnv would crash every client call of getBaseUrl(). In the client
  // bundle process.env.APP_BASE_URL is undefined, so client reads fall through to the public URL.
  // NEXT_PUBLIC_APP_URL is public and read at runtime via getEnv (next-runtime-env), with a
  // process.env fallback for when injection has not happened yet at module top level.
  const baseUrl = (
    process.env.APP_BASE_URL ??
    getEnv('NEXT_PUBLIC_APP_URL') ??
    process.env.NEXT_PUBLIC_APP_URL
  )?.trim()

  if (!baseUrl) {
    throw new Error(
      'NEXT_PUBLIC_APP_URL must be configured for webhooks and callbacks to work correctly'
    )
  }

  return normalizeBaseUrl(baseUrl)
}

/**
 * Base URL baked into the callback URL handed to async sandbox tools (pod relay
 * / api self-post / http relay POST their result back here). MUST be reachable
 * from wherever the tool runs — for pod tools that means a cluster-reachable
 * address, NOT localhost. Falls back to NEXT_PUBLIC_APP_URL when
 * CREWMELD_SANDBOX_CALLBACK_BASE_URL is not set.
 */
export function getSandboxCallbackBaseUrl(): string {
  const baseUrl = getEnv('CREWMELD_SANDBOX_CALLBACK_BASE_URL')?.trim()
  if (!baseUrl) {
    return getBaseUrl()
  }

  if (!hasHttpProtocol(baseUrl)) {
    throw new Error(
      'CREWMELD_SANDBOX_CALLBACK_BASE_URL must include protocol (http:// or https://), e.g. http://192.168.0.10:6100'
    )
  }

  return baseUrl
}

/**
 * Ensures a URL is absolute by prefixing the base URL when a relative path is provided.
 * @param pathOrUrl - Relative path (e.g., /api/files/serve/...) or absolute URL
 */
export function ensureAbsoluteUrl(pathOrUrl: string): string {
  if (!pathOrUrl) {
    throw new Error('URL is required')
  }

  if (pathOrUrl.startsWith('/')) {
    return `${getBaseUrl()}${pathOrUrl}`
  }

  return pathOrUrl
}

/**
 * Returns just the domain and port part of the application URL
 * @returns The domain with port if applicable (e.g., 'localhost:6100' or 'crewmeld.com')
 */
export function getBaseDomain(): string {
  try {
    const url = new URL(getBaseUrl())
    return url.host // host includes port if specified
  } catch (_e) {
    const fallbackUrl = getEnv('NEXT_PUBLIC_APP_URL') || 'http://localhost:6100'
    try {
      return new URL(fallbackUrl).host
    } catch {
      return 'localhost:6100'
    }
  }
}

/**
 * Returns the domain for email addresses, stripping www subdomain for Resend compatibility
 * @returns The email domain (e.g., 'crewmeld.ai' instead of 'www.crewmeld.ai')
 */
export function getEmailDomain(): string {
  try {
    const baseDomain = getBaseDomain()
    return baseDomain.startsWith('www.') ? baseDomain.substring(4) : baseDomain
  } catch (_e) {
    return 'localhost:6100'
  }
}
