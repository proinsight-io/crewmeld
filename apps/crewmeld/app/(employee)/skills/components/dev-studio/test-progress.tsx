'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/core/utils/cn'
import type { PhaseEvent, PhaseStep } from '@/lib/dev-studio/sandbox-loader'
import { useTranslation } from '@/hooks/use-translation'

interface TestProgressProps {
  events: PhaseEvent[]
}

/** Ordered pipeline steps displayed as a fixed progress list. */
const STEPS: PhaseStep[] = [
  'sync',
  'cache-libs',
  'create-sandbox',
  'init',
  'start',
  'invoke',
] as const

/** Derive the visual icon for a step given its latest status. */
function statusIcon(status: 'start' | 'done' | 'skip' | 'error' | 'pending'): string {
  switch (status) {
    case 'start':
      return '⟳' // ⟳
    case 'done':
      return '✓' // ✓
    case 'skip':
      return '⊘' // ⊘
    case 'error':
      return '✗' // ✗
    default:
      return '─' // ─
  }
}

function statusColor(status: 'start' | 'done' | 'skip' | 'error' | 'pending'): string {
  switch (status) {
    case 'start':
      return 'text-blue-500 dark:text-blue-400'
    case 'done':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'skip':
      return 'text-muted-foreground'
    case 'error':
      return 'text-destructive'
    default:
      return 'text-muted-foreground/50'
  }
}

/**
 * Displays the 8 sandbox-loader pipeline steps as a compact progress list.
 * Each step shows its ordinal, localised label, status icon, and duration
 * (when complete). Driven by the SSE `PhaseEvent[]` stream from the
 * run-test endpoint.
 */
export function TestProgress({ events }: TestProgressProps) {
  const { t } = useTranslation()

  /** Build a map from step name to latest event. */
  const stepMap = useMemo(() => {
    const map = new Map<PhaseStep, PhaseEvent>()
    for (const ev of events) {
      map.set(ev.step, ev)
    }
    return map
  }, [events])

  /** i18n key mapping for each step. */
  const labelKey: Record<PhaseStep, string> = {
    sync: 'devStudio.test.progressSync',
    'cache-libs': 'devStudio.test.progressCacheLibs',
    'create-sandbox': 'devStudio.test.progressCreateSandbox',
    init: 'devStudio.test.progressInit',
    start: 'devStudio.test.progressStart',
    invoke: 'devStudio.test.progressInvoke',
  }

  return (
    <div className='space-y-0.5 font-mono text-sm' data-testid='test-progress'>
      {STEPS.map((step, idx) => {
        const ev = stepMap.get(step)
        const status = ev?.status ?? 'pending'
        const icon = statusIcon(status)
        const color = statusColor(status)
        const duration = ev?.durationMs

        return (
          <div key={step} className='space-y-0.5' data-testid={`test-progress:step:${step}`}>
            <div className='flex items-center gap-2'>
              <span className='w-4 text-right text-muted-foreground'>{idx + 1}</span>
              <span className={cn('w-4 text-center', color)}>{icon}</span>
              <span className='flex-1'>{t(labelKey[step])}</span>
              {(status === 'done' || status === 'error') && duration !== undefined && (
                <span className='text-muted-foreground text-xs'>{duration}ms</span>
              )}
            </div>
            {status === 'error' && ev?.errorMessage && (
              <div
                className='ml-10 whitespace-pre-wrap break-words text-destructive text-xs'
                data-testid={`test-progress:error:${step}`}
              >
                {ev.errorMessage}
              </div>
            )}
            {status === 'skip' && ev?.reason && (
              <div className='ml-10 break-words text-muted-foreground text-xs'>{ev.reason}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
