export type RuntimeDurationName =
  | 'authMs'
  | 'conversationLoadMs'
  | 'identityMs'
  | 'routeMs'
  | 'ocrMs'
  | 'retrievalMs'
  | 'llmFirstTokenMs'
  | 'toolMs'
  | 'sopDispatchMs'

export type RuntimeTimingSnapshot = {
  traceId: string
  totalMs: number
} & Partial<Record<RuntimeDurationName, number>>

export interface RuntimeTiming {
  mark(name: string): number
  /** Adds the elapsed interval to the named duration across repeated measurements. */
  measure(name: RuntimeDurationName, start: number): void
  snapshot(): RuntimeTimingSnapshot
}

export function createRuntimeCompletionLogger(
  timing: RuntimeTiming,
  log: (snapshot: RuntimeTimingSnapshot) => void
): () => void {
  let completed = false

  return () => {
    if (completed) return
    completed = true
    log(timing.snapshot())
  }
}

export function createRuntimeTiming(
  traceId: string,
  clock: () => number = () => performance.now()
): RuntimeTiming {
  const requestStart = clock()
  const durations: Partial<Record<RuntimeDurationName, number>> = {}

  return {
    mark(_name) {
      return clock()
    },
    measure(name, start) {
      durations[name] = (durations[name] ?? 0) + Math.max(0, clock() - start)
    },
    snapshot() {
      return {
        traceId,
        ...durations,
        totalMs: Math.max(0, clock() - requestStart),
      }
    },
  }
}
