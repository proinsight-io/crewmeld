export type AdoptProgressStep =
  | 'syncing'
  | 'installing-dependencies'
  | 'saving'
  | 'closing'

export type AdoptProgressEvent =
  | { type: 'progress'; step: AdoptProgressStep; libraries?: string[] }
  | {
      type: 'complete'
      toolId: string
      toolName: string
      isUpdate: boolean
      needsRedeploy: boolean
    }
  | { type: 'error'; message: string; retryable: boolean }

export type AdoptProgressReporter = (
  event: Extract<AdoptProgressEvent, { type: 'progress' }>
) => void | Promise<void>

export function encodeSseEvent(event: AdoptProgressEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}
