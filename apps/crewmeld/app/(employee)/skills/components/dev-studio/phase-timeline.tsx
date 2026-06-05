'use client'

import { Fragment } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { cn } from '@/lib/core/utils/cn'

interface PhaseTimelineProps {
  /**
   * The session's pipeline phases as declared by the AI's `<pipeline>` marker.
   * `null` falls back to the canonical 6-step pipeline below.
   */
  pipelinePhases: string[] | null
  /** The current `<phase>` marker, or `null` when none has been entered yet. */
  currentPhase: string | null
  /** Audit trail of every phase that has been entered, in chronological order. */
  phaseHistory: Array<{ phase: string; enteredAt: string }>
}

/** Default 6-step pipeline applied when the session has not declared its own. */
const DEFAULT_PIPELINE = [
  'requirement',
  'design',
  'coding',
  'testing',
  'verification',
  'adoption',
] as const

/** Final phase that always terminates the timeline. */
const FINAL_PHASE = 'adoption'

/**
 * Maps canonical phase identifiers to i18n paths so the visible label
 * follows the operator's locale. Unknown phase names (AI custom pipelines)
 * fall through and render verbatim.
 */
const PHASE_KEY_TO_I18N: Record<string, string> = {
  requirement: 'devStudio.phase.requirement',
  design: 'devStudio.phase.design',
  coding: 'devStudio.phase.coding',
  writingTests: 'devStudio.phase.writingTests',
  selfTest: 'devStudio.phase.selfTest',
  testing: 'devStudio.phase.testing',
  refactor: 'devStudio.phase.refactor',
  verification: 'devStudio.phase.verification',
  adoption: 'devStudio.phase.adoption',
}

/**
 * Ensure the pipeline ends with the `adoption` phase.
 *
 * The AI is free to emit any phase sequence in its `<pipeline>` marker but
 * the operator UI always shows the final adoption step so the path forward
 * is visible. Appended only when missing — never duplicated.
 */
function ensureAdoptionLast(phases: string[]): string[] {
  if (phases.at(-1) === FINAL_PHASE) return phases
  return [...phases, FINAL_PHASE]
}

/**
 * Splice any phase names referenced by phaseHistory / currentPhase but
 * absent from the declared pipeline into the visible list, just before the
 * terminal adoption step. Preserves insertion order (historic first, then
 * current). Dedupes against the existing pipeline.
 */
function mergeUnknownPhases(base: string[], historic: string[], current: string | null): string[] {
  const known = new Set(base)
  const extras: string[] = []
  const seenExtra = new Set<string>()
  for (const p of historic) {
    if (!p || known.has(p) || seenExtra.has(p)) continue
    extras.push(p)
    seenExtra.add(p)
  }
  if (current && !known.has(current) && !seenExtra.has(current)) {
    extras.push(current)
    seenExtra.add(current)
  }
  if (extras.length === 0) return base
  const adoptIdx = base.indexOf(FINAL_PHASE)
  if (adoptIdx < 0) return [...base, ...extras]
  return [...base.slice(0, adoptIdx), ...extras, ...base.slice(adoptIdx)]
}

/**
 * Horizontal phase progress strip rendered in the dev-studio header.
 *
 * Each phase shows one of three states:
 *  - **done**   — entered earlier and not the current phase (✓ in green),
 *  - **active** — equals `currentPhase` (spinning loader in yellow),
 *  - **upcoming** — neither visited nor active (hollow circle in muted).
 */
export function PhaseTimeline({ pipelinePhases, currentPhase, phaseHistory }: PhaseTimelineProps) {
  const { t } = useTranslation()
  const localize = (phase: string): string => {
    const path = PHASE_KEY_TO_I18N[phase]
    if (!path) return phase
    const translated = t(path)
    return translated === path ? phase : translated
  }
  // Default pipeline shows only until the AI actually starts moving. Once
  // any <phase> marker or phaseHistory entry exists we treat that as the
  // AI's real progress and stop blending in the canonical 6-step default —
  // mixing them produced a confusing row with steps the AI never planned
  // to visit. Explicit <pipeline> from the AI wins over both.
  const aiProgress =
    phaseHistory.length > 0 || currentPhase
      ? Array.from(
          new Set([
            ...phaseHistory.map((h) => h.phase),
            ...(currentPhase ? [currentPhase] : []),
          ])
        )
      : null
  const source = pipelinePhases ?? aiProgress ?? [...DEFAULT_PIPELINE]
  // Belt-and-braces: even with the AI's own pipeline, splice in any
  // history/current names it didn't enumerate so the active highlight
  // never lands nowhere.
  const phases = mergeUnknownPhases(
    ensureAdoptionLast(source),
    phaseHistory.map((h) => h.phase),
    currentPhase
  )
  const visited = new Set(phaseHistory.map((h) => h.phase))
  // Default highlight: before the AI has emitted any <phase> marker, treat
  // the first pipeline step as the implicit "starting" phase so the timeline
  // doesn't look completely inert at session start. Falls back to the
  // explicit currentPhase as soon as one arrives.
  const effectiveActive = currentPhase ?? phases[0] ?? null
  // Implicit-done inference: any phase appearing in the rendered pipeline
  // BEFORE the current phase is treated as completed even if the AI never
  // emitted <phase>X</phase> for it. This handles the common case where the
  // AI skips emitting <phase>requirement</phase> for the brainstorming step
  // and jumps straight to <phase>design</phase> — without inference,
  // "requirement" stays
  // ○ forever even after the timeline has clearly moved past it. The
  // persisted phaseHistory remains the authoritative audit trail; this is
  // pure display-layer wayfinding.
  const activeIdx = currentPhase ? phases.indexOf(currentPhase) : -1

  return (
    <div className='flex items-center gap-1 text-xs' data-testid='dev-studio:phase-timeline'>
      {phases.map((p, i) => {
        const isActive = p === effectiveActive
        const isImplicitlyDone = activeIdx > 0 && i < activeIdx
        const isDone = (visited.has(p) || isImplicitlyDone) && !isActive
        return (
          <Fragment key={p}>
            {i > 0 && (
              <span className='text-muted-foreground' aria-hidden='true'>
                ─
              </span>
            )}
            <span
              className={cn(
                'flex items-center gap-1',
                isDone && 'text-emerald-600 dark:text-emerald-400',
                isActive && 'text-amber-600 dark:text-amber-400 font-medium',
                !isDone && !isActive && 'text-muted-foreground'
              )}
              data-testid={`dev-studio:phase-timeline:phase:${p}`}
            >
              {isDone && (
                <Check className='size-3' data-testid={`dev-studio:phase-timeline:done:${p}`} />
              )}
              {isActive && (
                <Loader2
                  className='size-3 animate-spin'
                  data-testid={`dev-studio:phase-timeline:active:${p}`}
                />
              )}
              {!isDone && !isActive && (
                <Circle
                  className='size-3'
                  data-testid={`dev-studio:phase-timeline:upcoming:${p}`}
                />
              )}
              <span>{localize(p)}</span>
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
