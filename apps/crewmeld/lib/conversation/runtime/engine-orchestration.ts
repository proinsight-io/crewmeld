import {
  createRuntimeCompletionLogger,
  type RuntimeDurationName,
  type RuntimeTiming,
  type RuntimeTimingSnapshot,
} from './timing'

export function createConversationRuntimeBoundary(
  timing: RuntimeTiming,
  onComplete: (snapshot: RuntimeTimingSnapshot) => void
): { complete: () => void; load: <T>(operation: () => Promise<T>) => Promise<T> } {
  const complete = createRuntimeCompletionLogger(timing, onComplete)
  return {
    complete,
    async load<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation()
      } catch (error) {
        complete()
        throw error
      }
    },
  }
}

export async function measureRuntimeOperation<T>(
  timing: RuntimeTiming,
  name: RuntimeDurationName,
  operation: () => Promise<T>
): Promise<T> {
  const start = timing.mark(name)
  try {
    return await operation()
  } finally {
    timing.measure(name, start)
  }
}

interface ConversationRuntimeOrchestration {
  timing: RuntimeTiming
  execute: (timing: RuntimeTiming) => Promise<void>
  onError: (error: unknown) => Promise<void>
  onComplete: (snapshot: RuntimeTimingSnapshot) => void
}

export async function runConversationRuntime({
  timing,
  execute,
  onError,
  onComplete,
}: ConversationRuntimeOrchestration): Promise<void> {
  try {
    await execute(timing)
  } catch (error) {
    await onError(error)
  } finally {
    onComplete(timing.snapshot())
  }
}

interface ConversationStreamStart extends ConversationRuntimeOrchestration {
  initialize: () => Promise<void>
}

export async function runConversationStreamStart({
  initialize,
  ...runtime
}: ConversationStreamStart): Promise<void> {
  await runConversationRuntime({
    ...runtime,
    execute: async (timing) => {
      await initialize()
      await runtime.execute(timing)
    },
  })
}
