import { useContext } from 'react'
import {
  customSessionClient,
  emailOTPClient,
  genericOAuthClient,
  organizationClient,
} from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import type { auth } from '@/lib/auth'
import { isBillingEnabled } from '@/lib/core/config/feature-flags'
import { SessionContext, type SessionHookResult } from '@/app/_shell/providers/session-provider'

/** Conditional plugin list — organization plugin only loaded when billing is active. */
const conditionalPlugins = isBillingEnabled ? [organizationClient()] : []

/**
 * Shared better-auth browser client for all auth operations.
 *
 * No `baseURL` is passed on purpose: better-auth then resolves it from
 * `window.location.origin`, so auth requests stay same-origin with whatever
 * host the page was loaded from (any LAN IP / domain). Hardcoding it to
 * `getBaseUrl()` (NEXT_PUBLIC_APP_URL) would force cross-origin requests —
 * e.g. a page on http://192.168.x.x:6100 posting to http://localhost:6100 —
 * which strips credentials and breaks login.
 */
export const client = createAuthClient({
  plugins: [
    emailOTPClient(),
    genericOAuthClient(),
    customSessionClient<typeof auth>(),
    ...conditionalPlugins,
  ],
})

/**
 * Access the session from the nearest SessionProvider.
 * Throws if no SessionProvider is mounted above the call site.
 */
export function useSession(): SessionHookResult {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error(
      'SessionProvider is not mounted. Wrap your app with <SessionProvider> in app/layout.tsx.'
    )
  }
  return ctx
}

/** Active organization hook — returns a no-op stub when billing is disabled. */
export const useActiveOrganization = isBillingEnabled
  ? client.useActiveOrganization
  : () => ({ data: undefined, isPending: false, error: null })

export const { signIn, signUp, signOut } = client
