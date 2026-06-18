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
 * Returns the base URL of the application from NEXT_PUBLIC_APP_URL
 * This ensures webhooks, callbacks, and other integrations always use the correct public URL
 * @returns The base URL string (e.g., 'http://localhost:6100' or 'https://example.com')
 * @throws Error if NEXT_PUBLIC_APP_URL is not configured
 */
export function getBaseUrl(): string {
  // getEnv depends on next-runtime-env and may not be injected yet when evaluated at the top level of client modules,
  // in which case fall back to process.env (Next.js inlines NEXT_PUBLIC_ variables at build time).
  const baseUrl = (getEnv('NEXT_PUBLIC_APP_URL') ?? process.env.NEXT_PUBLIC_APP_URL)?.trim()

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
