export interface HumanSupportConversationRef {
  conversationId: string
  employeeId: string
  channel: string
  externalUserId: string
  externalSessionId?: string
}

export function buildHumanSupportCardValue(ref: HumanSupportConversationRef): string {
  return JSON.stringify({ action: 'human_support_reply', ...ref })
}

export function parseHumanSupportCardValue(value: string): HumanSupportConversationRef | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const item = parsed as Record<string, unknown>
    if (
      item.action !== 'human_support_reply' ||
      typeof item.conversationId !== 'string' ||
      typeof item.employeeId !== 'string' ||
      typeof item.channel !== 'string' ||
      typeof item.externalUserId !== 'string'
    ) return null
    return {
      conversationId: item.conversationId,
      employeeId: item.employeeId,
      channel: item.channel,
      externalUserId: item.externalUserId,
      ...(typeof item.externalSessionId === 'string' ? { externalSessionId: item.externalSessionId } : {}),
    }
  } catch {
    return null
  }
}
