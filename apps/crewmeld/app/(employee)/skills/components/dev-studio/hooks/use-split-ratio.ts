'use client'

import { useCallback, useState } from 'react'

/**
 * Options for {@link useSplitRatio}.
 */
export interface UseSplitRatioOptions {
  /** Initial ratio when nothing is in storage. Default `0.6`. */
  defaultRatio?: number
  /** Ratio applied by {@link UseSplitRatioResult.onFocusLeft}. Default `0.7`. */
  focusLeftRatio?: number
  /** Ratio applied by {@link UseSplitRatioResult.onFocusRight}. Default `0.3`. */
  focusRightRatio?: number
  /** `localStorage` key used to persist the user-dragged ratio. */
  storageKey: string
  /** Minimum allowed ratio. Default `0.15`. */
  minRatio?: number
  /** Maximum allowed ratio. Default `0.85`. */
  maxRatio?: number
}

/**
 * Imperative API returned by {@link useSplitRatio}.
 */
export interface UseSplitRatioResult {
  /** Current left-pane width as a fraction in `[minRatio, maxRatio]`. */
  leftPct: number
  /** Called by SplitPane on mouseup with the new ratio; persists to localStorage. */
  onDragEnd: (pct: number) => void
  /** Temporarily collapse the right pane (does NOT persist). */
  onFocusLeft: () => void
  /** Temporarily collapse the left pane (does NOT persist). */
  onFocusRight: () => void
}

const DEFAULT_RATIO = 0.6
const FOCUS_LEFT_RATIO = 0.7
const FOCUS_RIGHT_RATIO = 0.3
const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * Persistent split-pane ratio hook.
 *
 * Drag-end commits write to `localStorage`; click-to-focus actions only
 * mutate the in-memory state so a temporary preview never overwrites the
 * user's preferred layout.
 *
 * SSR-safe: when `window` is undefined the default ratio is returned and
 * persistence becomes a no-op.
 */
export function useSplitRatio(opts: UseSplitRatioOptions): UseSplitRatioResult {
  const def = opts.defaultRatio ?? DEFAULT_RATIO
  const focusLeft = opts.focusLeftRatio ?? FOCUS_LEFT_RATIO
  const focusRight = opts.focusRightRatio ?? FOCUS_RIGHT_RATIO
  const min = opts.minRatio ?? MIN_RATIO
  const max = opts.maxRatio ?? MAX_RATIO

  const [leftPct, setLeftPct] = useState<number>(() => {
    if (typeof window === 'undefined') return clamp(def, min, max)
    const raw = window.localStorage.getItem(opts.storageKey)
    if (raw == null) return clamp(def, min, max)
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return clamp(def, min, max)
    return clamp(parsed, min, max)
  })

  const onDragEnd = useCallback(
    (pct: number) => {
      const clamped = clamp(pct, min, max)
      setLeftPct(clamped)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(opts.storageKey, String(clamped))
      }
    },
    [opts.storageKey, min, max]
  )

  const onFocusLeft = useCallback(() => {
    setLeftPct(clamp(focusLeft, min, max))
  }, [focusLeft, min, max])

  const onFocusRight = useCallback(() => {
    setLeftPct(clamp(focusRight, min, max))
  }, [focusRight, min, max])

  return { leftPct, onDragEnd, onFocusLeft, onFocusRight }
}
