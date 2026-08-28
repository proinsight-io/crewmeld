export type ConversationMessageKind = 'user' | 'event'

export type ConversationRuntimeSource = 'web' | 'api' | 'openai' | 'channel'

export type RuntimeKnowledgeScope = { mode: 'all' | 'selected'; ids: string[] }

export interface ConversationRuntimeRequest {
  conversationId: string
  employeeId: string
  actorUserId: string
  kind: ConversationMessageKind
  source: ConversationRuntimeSource
  content: string
  knowledgeScope: RuntimeKnowledgeScope
  attachments: Array<{ key: string; name: string; size: number; mimeType: string }>
  localeHint?: string
  connectionId?: string
  channelConfig?: Record<string, unknown>
}

export function parseKnowledgeScope(raw: string | null): RuntimeKnowledgeScope {
  if (raw === null) {
    return { mode: 'all', ids: [] }
  }

  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]

  return ids.length === 0 ? { mode: 'all', ids: [] } : { mode: 'selected', ids }
}
