import type { ChannelUserDetail } from '@/lib/channels/directory-types'

/** Platform-injected caller identity/scope for scoped data access (non-overridable by the LLM). */
export interface ScopeIdentity {
  /** Bound user id — on dev0.0.1 this is the IM channel userid. */
  employeeId?: string
  /** Caller's positions / job titles. */
  positions: string[]
  /** Caller's employee number (工号). Undefined when the channel does not expose it. */
  employeeNo?: string
  /** Direct leader's channel-native id (same id space as employeeId). Undefined when the channel does not expose it. */
  leaderId?: string
  /** Platform RBAC roles, populated for web callers (no IM org identity). Undefined for IM channels. */
  roles?: string[]
  /** Org/data scope the caller belongs to. */
  scope: { orgUnitIds: string[]; storeIds?: string[] }
  /**
   * IM-level caller info — present for any real inbound message regardless of
   * channel or resolution status, including web and anonymous callers that map
   * to no internal employee. This is the base "who sent this" that
   * forwardIdentity forwards when no org scope resolved; the fields above
   * (positions/employeeNo/scope) are the enrichment on top.
   */
  profile?: {
    /** Channel the message came in on, e.g. 'web' | 'feishu' | 'dingtalk' | 'wecom'. */
    channel: string
    /** Channel-native caller id (web user id / open_id / userid). */
    externalUserId: string
    /** Display name of the caller, when known. */
    senderName?: string
  }
  /**
   * Full normalized channel directory record — present only when IM resolution
   * succeeds. Source for extended permission-match fields (email/mobile/name/
   * deptNames/employeeType). Undefined for web/anonymous callers.
   */
  raw?: ChannelUserDetail
}

/** Inputs to resolve a caller's identity from an IM channel. */
export interface ChannelIdentityInput {
  /** Channel kind, e.g. 'feishu' | 'dingtalk' | 'wecom'. */
  channel: string
  /** Channel-native user id (open_id / userid). */
  userId: string
  /**
   * Credentials of the connection that received the message (threaded from the
   * webhook). The receiving app is used directly — there is no system-default
   * fallback. Per channel: feishu {appId,appSecret} / dingtalk {appKey,appSecret}
   * / wecom {corpId,corpSecret}.
   */
  config?: Record<string, unknown>
  /**
   * Channel directory field names to passthrough into `raw.attributes` so
   * data-access-policy rowFilters can bind to them via `raw.attributes.<field>`.
   * Sourced from the binding's `channelAttributePassthrough`. Only the named
   * fields are picked; undeclared fields are never copied. Omit to passthrough none.
   */
  attributePassthrough?: string[]
}
