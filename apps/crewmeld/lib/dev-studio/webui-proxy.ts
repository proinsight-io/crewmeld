import type { SDKMessage, StreamResponse } from './schemas'

export interface ProxyHooks {
  /**
   * Called for each `claude_json` frame's `data` field.
   * Return a (possibly mutated) SDKMessage to forward, or null to drop the frame.
   *
   * A.min: no hooks passed; behavior is identity transform.
   * C phase will inject the UI dispatcher model here.
   */
  onMessage?: (msg: SDKMessage) => SDKMessage | null
}

/**
 * Creates a TransformStream that line-buffers NDJSON, optionally rewrites
 * frames via `hooks.onMessage`, and re-serializes to bytes.
 *
 * Behavior:
 * - Lines split across chunks are stitched (UTF-8 boundary-safe via TextDecoder stream mode).
 * - Malformed JSON lines are forwarded verbatim (no crash).
 * - Non-`claude_json` frames (error/done/aborted) bypass the hook.
 * - Trailing buffer without final newline is flushed at stream end.
 */
export function createNDJSONInterceptor(
  hooks: ProxyHooks = {}
): TransformStream<Uint8Array, Uint8Array> {
  let buffer = ''
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  function emitLine(line: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!line) return
    let parsed: StreamResponse
    try {
      parsed = JSON.parse(line) as StreamResponse
    } catch {
      // Forward malformed lines as-is
      controller.enqueue(encoder.encode(line + '\n'))
      return
    }
    if (parsed.type === 'claude_json' && hooks.onMessage) {
      const result = hooks.onMessage(parsed.data)
      if (result === null) return // drop frame
      parsed = { ...parsed, data: result }
    }
    controller.enqueue(encoder.encode(JSON.stringify(parsed) + '\n'))
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) emitLine(line, controller)
    },
    flush(controller) {
      if (buffer) {
        emitLine(buffer, controller)
        buffer = ''
      }
    },
  })
}
