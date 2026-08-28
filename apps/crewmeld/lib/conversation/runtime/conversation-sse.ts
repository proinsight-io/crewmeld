import { encodeSSE } from '@/lib/core/utils/sse'
import type { ConversationEvent, KnowledgeChunkReference } from '../types'

export function createConversationSseEmitter(enqueue: (chunk: Uint8Array) => void) {
  const emit = (event: ConversationEvent) => enqueue(encodeSSE(event))
  return {
    progress(message: string) {
      emit({ type: 'progress', data: { message } })
    },
    messageStart(round: number) {
      emit({ type: 'message:start', data: { round } })
    },
    messageDelta(content: string) {
      emit({ type: 'message:delta', data: { content } })
    },
    messageDone(
      messageId: string,
      tokensUsed: number,
      references: KnowledgeChunkReference[]
    ) {
      emit({ type: 'message:done', data: { messageId, tokensUsed, references } })
    },
    startMessage(round: number) {
      emit({ type: 'message:start', data: { round } })
      let state: 'started' | 'streaming' | 'tool-only' | 'done' = 'started'
      return {
        delta(content: string) {
          if (state === 'done') throw new Error('message sequence is already done')
          if (state === 'tool-only') throw new Error('message sequence is tool-only')
          emit({ type: 'message:delta', data: { content } })
          state = 'streaming'
        },
        done(
          messageId: string,
          tokensUsed: number,
          references: KnowledgeChunkReference[]
        ) {
          if (state === 'done') throw new Error('message sequence is already done')
          if (state === 'tool-only') throw new Error('message sequence is tool-only')
          emit({ type: 'message:done', data: { messageId, tokensUsed, references } })
          state = 'done'
        },
        toolOnly() {
          if (state === 'done') throw new Error('message sequence is already done')
          if (state === 'tool-only') throw new Error('message sequence is already tool-only')
          if (state === 'streaming') throw new Error('streaming message cannot become tool-only')
          state = 'tool-only'
        },
      }
    },
  }
}
