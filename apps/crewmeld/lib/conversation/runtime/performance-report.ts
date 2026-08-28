import type { RuntimeTimingSnapshot } from './timing'

type RuntimeTimingStage = Exclude<keyof RuntimeTimingSnapshot, 'traceId'>

export type RuntimeTimingPercentiles = {
  p50: number
  p95: number
}

export type RuntimeTimingSummary = {
  count: number
  stages: Partial<Record<RuntimeTimingStage, RuntimeTimingPercentiles>>
}

const TIMING_STAGES = [
  'totalMs',
  'authMs',
  'conversationLoadMs',
  'identityMs',
  'routeMs',
  'ocrMs',
  'retrievalMs',
  'llmFirstTokenMs',
  'toolMs',
  'sopDispatchMs',
] as const satisfies readonly RuntimeTimingStage[]

function nearestRank(sortedValues: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  return sortedValues[index]
}

export function summarizeRuntimeTimings(
  samples: readonly RuntimeTimingSnapshot[]
): RuntimeTimingSummary {
  const stages: RuntimeTimingSummary['stages'] = {}

  for (const stage of TIMING_STAGES) {
    const values = samples
      .map((sample) => sample[stage])
      .filter((value): value is number => value !== undefined && Number.isFinite(value))
      .sort((left, right) => left - right)

    if (values.length === 0) continue
    stages[stage] = {
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
    }
  }

  return { count: samples.length, stages }
}
