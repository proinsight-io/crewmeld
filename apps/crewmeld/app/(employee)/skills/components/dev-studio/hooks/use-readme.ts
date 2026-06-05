'use client'

import useSWR, { type KeyedMutator } from 'swr'

/**
 * SWR fetcher for the README endpoint.
 *
 * The route returns `text/markdown`, not JSON — we read `.text()` directly.
 * A 404 yields `null` so the consumer can render an empty state. Other
 * non-2xx propagate as SWR errors.
 */
async function readmeFetcher(url: string): Promise<string | null> {
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Readme request failed (${res.status})`)
  }
  return await res.text()
}

/**
 * Return type for {@link useReadme}.
 */
export interface UseReadmeResult {
  /** Raw markdown string, or `null` when the workspace has no README yet. */
  readme: string | null
  /** SWR error (network failure, server error). */
  error: Error | undefined
  /** SWR mutator — call after a PUT to revalidate. */
  mutate: KeyedMutator<string | null>
}

/**
 * SWR-backed README fetch for a given session.
 *
 * Pass `null` as `sessionId` to disable the request. 404 = no README yet
 * (not an error); other non-2xx surface via `error`.
 */
export function useReadme(sessionId: string | null): UseReadmeResult {
  const key = sessionId
    ? `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/readme`
    : null
  // Same rationale as useManifest: poll every 5s so the README the AI is
  // writing in the sandbox surfaces in the "说明" tab without a manual
  // refresh. BFF reads .crewmeld-studio/README.md off disk per request.
  const { data, error, mutate } = useSWR<string | null>(key, readmeFetcher, {
    refreshInterval: 5_000,
  })
  return {
    readme: data ?? null,
    error: error as Error | undefined,
    mutate,
  }
}
