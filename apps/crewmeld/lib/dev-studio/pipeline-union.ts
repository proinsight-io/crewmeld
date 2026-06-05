/**
 * Merge a freshly-emitted `<pipeline>` into the session's existing pipeline.
 *
 * The B-protocol decision table originally said "replace pipeline_phases on
 * every emit". In practice the AI routinely drops already-completed phase
 * names from its later `<pipeline>` emits — "needs" disappears from the
 * timeline halfway through a session, even though the operator just walked
 * through it. This violates the "needs is a mandatory first step" expectation
 * users have.
 *
 * Union semantics fix the symptom without trusting the AI:
 *   1. Historical phase names are preserved in their original order — the
 *      sequence operators have already seen never reshuffles.
 *   2. New names from `incoming` that are not already present are appended in
 *      the order they appear in `incoming`.
 *   3. Duplicates collapse — each phase name appears exactly once.
 *
 * Reordering attempts are ignored (history wins). A trailing terminal phase
 * such as `采纳` is the caller's responsibility — apply `ensureAdoptionLast`
 * after this function so the synthetic adopt step always lands at the end
 * regardless of where it falls in either input.
 */
export function mergePipelineUnion(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of existing) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    merged.push(p)
  }
  for (const p of incoming) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    merged.push(p)
  }
  return merged
}
