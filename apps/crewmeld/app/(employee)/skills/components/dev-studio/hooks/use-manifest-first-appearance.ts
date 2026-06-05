'use client'

import { useEffect, useRef } from 'react'

/**
 * Fire `onFirstAppear` exactly once per session the first time the manifest
 * transitions from absent → present.
 *
 * Why a custom hook instead of an effect inline in {@link WorkspacePanel}?
 *  - Switching sessions must reset the "previously-seen" memory so the next
 *    session can fire its own first-appear callback.
 *  - Hot reload / SWR revalidation can briefly flip `isPresent` back to
 *    `false` and forward again; we deduplicate by latching on `true` and
 *    only releasing when the session id changes.
 *
 * The callback is invoked from a `useEffect`, so consumers can safely call
 * other React state setters inside it.
 */
export function useManifestFirstAppearance(
  sessionId: string | null,
  isPresent: boolean,
  onFirstAppear: () => void
): void {
  const prevPresentRef = useRef(false)
  const seenSessionRef = useRef<string | null>(null)

  useEffect(() => {
    // Session changed — clear the latch so the next manifest appearance fires.
    if (seenSessionRef.current !== sessionId) {
      prevPresentRef.current = false
      seenSessionRef.current = sessionId
    }
    if (isPresent && !prevPresentRef.current) {
      prevPresentRef.current = true
      onFirstAppear()
    }
  }, [sessionId, isPresent, onFirstAppear])
}
