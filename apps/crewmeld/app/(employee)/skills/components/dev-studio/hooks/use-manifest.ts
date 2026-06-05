'use client'

import useSWR, { type KeyedMutator } from 'swr'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'

interface ManifestPayload {
  manifest: ManifestT
}

/**
 * SWR fetcher for the manifest endpoint.
 *
 * Returns `null` on 404 so the consumer can render an empty state without an
 * error banner. Any other non-2xx propagates as an SWR error so the UI can
 * surface real failures — and for the 422 `manifest-invalid` case we lift the
 * server's `detail` (the JSON/Zod parse error) into the thrown message so the
 * test panel can tell the operator *why* the manifest won't load instead of
 * showing a silent blank panel.
 */
async function manifestFetcher(url: string): Promise<ManifestPayload | null> {
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { detail?: string; error?: string }
      | null
    const detail = body?.detail ?? body?.error
    throw new Error(detail ?? `Manifest request failed (${res.status})`)
  }
  return (await res.json()) as ManifestPayload
}

/**
 * Return type for {@link useManifest}.
 */
export interface UseManifestResult {
  /** Parsed manifest, or `null` when the workspace has not authored one yet. */
  manifest: ManifestT | null
  /** `true` when the BFF returned a manifest payload (vs 404). */
  isPresent: boolean
  /** SWR error from the fetcher (network failure, server error, etc). */
  error: Error | undefined
  /** SWR mutator — call after a PATCH to revalidate. */
  mutate: KeyedMutator<ManifestPayload | null>
}

/**
 * SWR-backed manifest fetch for a given session.
 *
 * Pass `null` as `sessionId` to disable the request (e.g. before a session is
 * picked). 404 responses are treated as "no manifest yet" rather than errors.
 */
export function useManifest(sessionId: string | null): UseManifestResult {
  const key = sessionId
    ? `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/manifest`
    : null
  // Poll every 5s so the manifest the AI is writing in the sandbox shows up
  // in the header / tool-meta-bar without the operator having to switch tabs
  // or refresh. The BFF reads the file off disk on every request — cheap
  // enough that a 5s cadence is fine, and we get near-realtime sync for the
  // moment after the AI calls Write on .crewmeld-studio/manifest.json.
  const { data, error, mutate } = useSWR<ManifestPayload | null>(key, manifestFetcher, {
    refreshInterval: 5_000,
  })
  return {
    manifest: data?.manifest ?? null,
    isPresent: !!data?.manifest,
    error: error as Error | undefined,
    mutate,
  }
}
