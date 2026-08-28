import { resolveChannelIdentity } from '@/lib/identity/channel-identity'
import type { ScopeIdentity } from '@/lib/identity/types'
import { resolveWebIdentity } from '@/lib/identity/web-identity'

interface ConversationIdentityInput {
  channel: string | null | undefined
  userId: string
  connectionId: string | undefined
  channelConfig: Record<string, unknown> | undefined
}

interface ConversationIdentityResult {
  identity: ScopeIdentity | null
  connectionId: string | null
}

/** Resolve platform and IM callers into the identity used by SOP visibility checks. */
export async function resolveConversationIdentity(
  input: ConversationIdentityInput
): Promise<ConversationIdentityResult> {
  if (input.channel === 'web' || input.channel === 'api') {
    return {
      identity: await resolveWebIdentity(input.userId),
      connectionId: input.channel,
    }
  }
  if (input.channel) {
    return {
      identity: await resolveChannelIdentity({
        channel: input.channel,
        userId: input.userId,
        config: input.channelConfig,
      }),
      connectionId: input.connectionId ?? null,
    }
  }
  return { identity: null, connectionId: null }
}
