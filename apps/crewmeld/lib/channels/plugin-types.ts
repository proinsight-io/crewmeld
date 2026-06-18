/**
 * Channel plugin type definitions - ChannelPlugin<TConfig> interface
 */

import type { ConversationChannel } from '@crewmeld/db/schema'
import type { z } from 'zod'
import type { ChannelMessage } from './types'

export interface ChannelCapabilities {
  direct: boolean
  channel: boolean
  threads: boolean
  media: boolean
  reactions: boolean
  editing: boolean
  replies: boolean
  cards: boolean
  websocket: boolean
}

export interface CardActionEvent {
  action: string
  pauseId: string
  token?: string
  operatorId: string
  messageId?: string
  taskId?: string
  rawPayload?: Record<string, unknown>
}

export interface SendTextParams {
  receiveId: string
  receiveIdType?: string
  content: string
}

export interface SendFileParams {
  receiveId: string
  receiveIdType?: string
  file: { name: string; mimeType: string; base64: string }
}

export interface SendCardParams {
  receiveId: string
  receiveIdType?: string
  card: Record<string, unknown>
}

export interface UpdateCardParams {
  messageId: string
  card: Record<string, unknown>
  toUser?: string
}

export interface ApprovalCardParams {
  pauseId: string
  sopName: string
  nodeName: string
  approvalToken?: string
  aiSummary?: string
  deadline?: string
  previousResult?: string
  approvalPageUrl?: string
  senderName?: string
  language?: string
}

export interface ApprovalDoneCardParams {
  sopName: string
  nodeName: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  senderName?: string
  previousResult?: string
  decidedAt?: Date
  language?: string
}

/** A known raw directory field a channel exposes, for the field-map combobox dropdown. */
export interface RawFieldDef {
  /** Path into the channel's raw record. */
  path: string
  /** zh-CN label for display. */
  label: string
}

export interface ChannelPlugin<TConfig = Record<string, unknown>> {
  id: ConversationChannel
  label: string
  aliases?: string[]
  /** Known raw directory field paths for the identity field-map editor dropdown. */
  identityRawFields?: RawFieldDef[]
  capabilities: ChannelCapabilities
  configSchema: z.ZodType<TConfig>
  inbound: {
    verifySignature(request: Request, bodyText: string, config: TConfig): Promise<boolean>
    handleVerification?(body: Record<string, unknown>, config: TConfig): Promise<Response | null>
    decryptPayload?(body: Record<string, unknown>, config: TConfig): Record<string, unknown> | null
    parseMessage(body: Record<string, unknown>, config: TConfig): ChannelMessage | null
    parseCardAction?(body: Record<string, unknown>, config: TConfig): CardActionEvent | null
  }
  outbound: {
    deliveryMode: 'direct' | 'response'
    chunkerMode: 'text' | 'markdown'
    textChunkLimit: number
    sendText(params: SendTextParams, config: TConfig): Promise<void>
    sendMedia?(params: SendTextParams, config: TConfig): Promise<void>
    sendFile?(params: SendFileParams, config: TConfig): Promise<void>
    sendCard?(params: SendCardParams, config: TConfig): Promise<string | undefined>
    updateCard?(params: UpdateCardParams, config: TConfig): Promise<void>
  }
  buildApprovalCard?(params: ApprovalCardParams): Record<string, unknown>
  buildApprovalDoneCard?(params: ApprovalDoneCardParams): Record<string, unknown>
}
