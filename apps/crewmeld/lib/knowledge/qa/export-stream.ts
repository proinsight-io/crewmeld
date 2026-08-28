import { createQaCsvLine, QA_CSV_HEADER } from './export'
import type { QaQuestionRecord } from './types'

/** Creates a backpressure-aware CSV stream that enqueues at most one chunk per pull. */
export function createQaCsvStream(
  pages: AsyncIterable<QaQuestionRecord[]>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = pages[Symbol.asyncIterator]()
  let headerSent = false
  let page: QaQuestionRecord[] = []
  let rowIndex = 0
  let aborted = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (aborted) return
      try {
        if (!headerSent) {
          headerSent = true
          controller.enqueue(encoder.encode(`\uFEFF${QA_CSV_HEADER}`))
          return
        }
        while (rowIndex >= page.length) {
          const next = await iterator.next()
          if (next.done) {
            controller.close()
            return
          }
          page = next.value
          rowIndex = 0
        }
        controller.enqueue(encoder.encode(createQaCsvLine(page[rowIndex++]!)))
      } catch (error) {
        aborted = true
        controller.error(error)
      }
    },
    async cancel() {
      aborted = true
      await iterator.return?.()
    },
  })
}
