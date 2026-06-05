/**
 * Dev Studio API request/response Zod contracts
 *
 * Key security constraints:
 * - ChatRequestSchema does **not** accept workingDirectory / allowedTools / permissionMode.
 *   The BFF forcibly injects workingDirectory="/root/workspace" when forwarding to claude-code-webui,
 *   preventing the frontend from accessing arbitrary container paths.
 */
import { z } from 'zod'

// ────── Request/Response Contracts ──────

export const CreateSessionRequestSchema = z.object({}).strict()
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.literal('ready'),
})
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const ChatRequestSchema = z
  .object({
    message: z.string().min(1).max(64_000),
    requestId: z.string().uuid(),
    sessionId: z.string().optional(), // claude-code-webui internal session id (empty on first message)
  })
  .strict()
export type ChatRequest = z.infer<typeof ChatRequestSchema>

export const AbortRequestSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict()
export type AbortRequest = z.infer<typeof AbortRequestSchema>

// ────── Unified Error Response Shape ──────

export type ApiError = {
  error: string
  detail?: string
  retryable: boolean
}

// ────── Internal State ──────

export const SessionInfoSchema = z.object({
  sessionId: z.string().uuid(),
  sandboxId: z.string(),
  webuiUrl: z.string().url(),
  createdAt: z.date(),
  lastChatAt: z.date(),
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

// ────── claude-code-webui NDJSON Stream Protocol ──────
//
// We do not import @anthropic-ai/claude-code SDK; define minimal local types at the BFF layer,
// only caring about type / session_id / content fields. Other fields are passed through.

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: unknown
      is_error?: boolean
    }
  | { type: 'thinking'; thinking?: string }
  // Forward-compatibility catch-all for unknown block types from upstream.
  // Note: this prevents TypeScript discriminated-union narrowing on `type`;
  // consumers must use type predicate helpers (e.g. `isTextBlock(b)`) to narrow.
  | { type: string; [key: string]: unknown }

// Note: the index signature below makes `SDKMessage.type` non-narrowable in
// switch statements. This is intentional — `SDKMessage` is a pass-through
// envelope, not an exhaustively-typed payload. Consumers should narrow via
// `if (msg.type === '...')` and accept the explicit cast it requires.
//
// Content location: the real SDK nests blocks under `message.content`
// (Anthropic API envelope shape). Older fixtures put them at the top level
// under `content`. Both fields are typed so consumers can stay tolerant —
// helpers in chat/route.ts read via getContent(msg) which checks the
// envelope first and falls back to the top level.
export type SDKMessage = {
  type: 'system' | 'assistant' | 'user' | 'result'
  session_id?: string
  message?: { content?: ContentBlock[]; [key: string]: unknown }
  content?: ContentBlock[]
  [key: string]: unknown
}

export type StreamResponse =
  | { type: 'claude_json'; data: SDKMessage }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'aborted' }
