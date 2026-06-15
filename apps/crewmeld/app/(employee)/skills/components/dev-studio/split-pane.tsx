'use client'

import { Children, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Props for {@link SplitPane}.
 */
export interface SplitPaneProps {
  /** Width of the left pane as a fraction in `[minRatio, maxRatio]`. */
  leftPct: number
  /** Invoked on mouse-up with the final ratio (parent persists it). */
  onDragEnd: (pct: number) => void
  /** Optional minimum ratio for drag clamping. Default `0.15`. */
  minRatio?: number
  /** Optional maximum ratio for drag clamping. Default `0.85`. */
  maxRatio?: number
  /**
   * When `false`, the right pane + divider are hidden and the left pane
   * fills the full width. Defaults to `true`. Lets callers toggle the right
   * pane without remounting the left subtree (so chat scroll position and
   * the message list survive the toggle).
   */
  showRight?: boolean
  /** Exactly two children: `[left, right]`. */
  children: ReactNode
}

const DEFAULT_MIN = 0.15
const DEFAULT_MAX = 0.85

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Horizontal split pane with a draggable divider.
 *
 * The component is controlled — parent owns the ratio via `leftPct` and is
 * notified on mouse-up via `onDragEnd`. During an active drag we update a
 * local preview ratio (`dragPct`) so the parent never sees jittery values.
 */
export function SplitPane({
  leftPct,
  onDragEnd,
  minRatio = DEFAULT_MIN,
  maxRatio = DEFAULT_MAX,
  showRight = true,
  children,
}: SplitPaneProps) {
  const { t } = useTranslation()
  const childArray = Children.toArray(children)
  const left = childArray[0]
  const right = childArray[1]

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dragPct, setDragPct] = useState<number | null>(null)
  const draggingRef = useRef(false)

  const effectivePct = dragPct ?? leftPct

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!draggingRef.current) return
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (rect.width === 0) return
      const ratio = clamp((event.clientX - rect.left) / rect.width, minRatio, maxRatio)
      setDragPct(ratio)
    },
    [minRatio, maxRatio]
  )

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragPct((current) => {
      if (current != null) onDragEnd(current)
      return null
    })
  }, [onDragEnd])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const handleMouseDown = useCallback(() => {
    draggingRef.current = true
  }, [])

  const leftPercent = showRight ? `${effectivePct * 100}%` : '100%'
  const rightPercent = `${(1 - effectivePct) * 100}%`

  return (
    <div
      ref={containerRef}
      // Note: NO select-none here. Previously the whole container disabled
      // text selection to prevent text being selected mid-drag, but it
      // also killed copy-from-chat for the operator. Selection suppression
      // is now applied only on the divider button (where dragging happens),
      // plus dynamically on the container while dragging is active.
      className={cn('flex w-full h-full overflow-hidden', dragPct !== null && 'select-none')}
      data-testid='split-pane'
    >
      <div
        className='h-full overflow-hidden'
        style={{ width: leftPercent }}
        data-testid='split-pane:left'
      >
        {left}
      </div>
      {showRight && (
        <>
          {/* Drag handle: 8px-wide transparent hit area with a centred 1px
              visible line. Wider grab zone makes mouse acquisition forgiving
              without changing the visual gutter width. */}
          <button
            type='button'
            aria-label={t('devStudio.header.splitDividerAria')}
            onMouseDown={handleMouseDown}
            className='group relative h-full w-2 flex-shrink-0 cursor-col-resize bg-transparent select-none'
            data-testid='split-pane:divider'
          >
            <span className='pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent group-active:bg-accent' />
          </button>
          <div
            className='h-full overflow-hidden'
            style={{ width: rightPercent }}
            data-testid='split-pane:right'
          >
            {right}
          </div>
        </>
      )}
    </div>
  )
}
