'use client'

import useSWR from 'swr'

export type EgressMode = 'unrestricted' | 'allowlist'

const EGRESS_MODE_URL = '/api/employee/dev-studio/egress-mode'

async function egressModeFetcher(url: string): Promise<EgressMode> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`egress-mode request failed (${res.status})`)
  const body = (await res.json()) as { egressMode: EgressMode }
  return body.egressMode
}

/**
 * Read the admin global egress mode. Returns `undefined` while loading or on
 * error — callers should treat unknown as "unrestricted" (the out-of-box
 * default), e.g. hide the per-run 临时白名单 input until proven `allowlist`.
 */
export function useEgressMode(): EgressMode | undefined {
  const { data } = useSWR<EgressMode>(EGRESS_MODE_URL, egressModeFetcher, {
    refreshInterval: 60_000,
  })
  return data
}
