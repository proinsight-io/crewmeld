'use client'

import { useCallback, useRef, useState } from 'react'
import type {
  AdoptProgressEvent,
  AdoptProgressStep,
} from '@/lib/dev-studio/adopt-progress'

export type AdoptProgressState =
  | { kind: 'idle' }
  | { kind: 'processing'; step: AdoptProgressStep; libraries: string[] }
  | { kind: 'failed'; message: string; retryable: boolean }

type CompleteEvent = Extract<AdoptProgressEvent, { type: 'complete' }>

interface UseAdoptProgressOptions {
  onComplete: (event: CompleteEvent) => void | Promise<void>
  networkErrorMessage: string
}

function parseEvent(frame: string): AdoptProgressEvent | null {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
  if (!dataLine) return null

  try {
    const value = JSON.parse(dataLine.slice(6)) as Partial<AdoptProgressEvent>
    if (value.type === 'progress' && typeof value.step === 'string') {
      return value as AdoptProgressEvent
    }
    if (value.type === 'complete' && typeof value.toolId === 'string') {
      return value as AdoptProgressEvent
    }
    if (
      value.type === 'error' &&
      typeof value.message === 'string' &&
      typeof value.retryable === 'boolean'
    ) {
      return value as AdoptProgressEvent
    }
  } catch {
    return null
  }
  return null
}

export function useAdoptProgress({
  onComplete,
  networkErrorMessage,
}: UseAdoptProgressOptions) {
  const [state, setState] = useState<AdoptProgressState>({ kind: 'idle' })
  const lastSessionId = useRef<string | null>(null)

  const start = useCallback(
    async (sessionId: string) => {
      lastSessionId.current = sessionId
      setState({ kind: 'processing', step: 'syncing', libraries: [] })

      try {
        const response = await fetch(
          `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/adopt`,
          { method: 'PATCH', headers: { Accept: 'text/event-stream' } },
        )
        if (!response.ok || !response.body) throw new Error('missing event stream')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let terminalEvent = false

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const event = parseEvent(frame)
            if (!event) continue
            if (event.type === 'progress') {
              setState({
                kind: 'processing',
                step: event.step,
                libraries: event.libraries ?? [],
              })
            } else if (event.type === 'error') {
              terminalEvent = true
              setState({
                kind: 'failed',
                message: event.message,
                retryable: event.retryable,
              })
            } else {
              terminalEvent = true
              await onComplete(event)
              setState({ kind: 'idle' })
            }
          }
        }

        if (!terminalEvent) throw new Error('event stream ended without a result')
      } catch {
        setState({ kind: 'failed', message: networkErrorMessage, retryable: true })
      }
    },
    [networkErrorMessage, onComplete],
  )

  const retry = useCallback(async () => {
    if (lastSessionId.current) await start(lastSessionId.current)
  }, [start])

  const dismissError = useCallback(() => setState({ kind: 'idle' }), [])

  return { state, start, retry, dismissError }
}
