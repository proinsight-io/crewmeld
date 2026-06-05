'use client'

import { useEffect, useRef } from 'react'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'

/**
 * Fire `onUpdate` when an already-present manifest changes (updatedAt differs).
 *
 * Complements {@link useManifestFirstAppearance}: that hook fires once when the
 * manifest transitions absent→present; this one fires on every subsequent change
 * (e.g. the AI rewrites the entrypoint or patches the input schema).
 *
 * Resets when `sessionId` changes so a new session starts with a clean slate.
 */
export function useManifestUpdate(
  sessionId: string | null,
  manifest: ManifestT | null,
  onUpdate: () => void
): void {
  const prevUpdatedAtRef = useRef<string | null>(null)
  const prevSessionRef = useRef<string | null>(null)

  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevUpdatedAtRef.current = null
      prevSessionRef.current = sessionId
    }
    if (!manifest) return

    const ts = manifest.updatedAt
    if (prevUpdatedAtRef.current === null) {
      prevUpdatedAtRef.current = ts
      return
    }
    if (ts !== prevUpdatedAtRef.current) {
      prevUpdatedAtRef.current = ts
      onUpdate()
    }
  }, [sessionId, manifest, onUpdate])
}
