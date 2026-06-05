/**
 * POST /api/employee/dev-studio/sessions/:sessionId/answer-ask
 *
 * Sub-spec B Phase 8: relays the operator's response to a pending HITL
 * `<ask>` prompt back to the AI. Flips the matching row in
 * `tool_dev_pending_actions` from `pending` to `answered`, persists the
 * answer JSON + timestamp, and queues an `<answer id="..."></answer>`
 * system note so the AI sees the answer in-band on its next chat turn.
 *
 * Body shape:
 *   { askId: string, answer: unknown }
 *
 * The `answer` field is intentionally untyped — the UI binds it to whatever
 * widget rendered the prompt (radio choice, confirm button, text input). A
 * convenience envelope `{ value }` is unwrapped automatically; bare values
 * pass through unchanged. The final value is JSON-stringified inside the
 * system note so structured payloads round-trip cleanly.
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 400 — body missing `askId` or fails schema
 *  - 204 — answer persisted + note queued
 *
 * Cross-user lookups return 404 (no info leak), matching sibling routes.
 */
import { db, toolDevPendingActions } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const AnswerSchema = z
  .object({
    askId: z.string().min(1),
    answer: z.unknown(),
  })
  .strict()

/**
 * Type guard: does `answer` look like the conventional `{value: ...}` envelope?
 *
 * Avoids casting to `any` while still letting the route accept either the
 * envelope or a bare value from the UI.
 */
function isValueEnvelope(answer: unknown): answer is { value: unknown } {
  return (
    answer !== null &&
    typeof answer === 'object' &&
    'value' in (answer as Record<string, unknown>)
  )
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = AnswerSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const { askId, answer } = parsed.data
  const value = isValueEnvelope(answer) ? answer.value : answer

  await db
    .update(toolDevPendingActions)
    .set({ status: 'answered', answer, answeredAt: new Date() })
    .where(
      and(
        eq(toolDevPendingActions.sessionId, sessionId),
        eq(toolDevPendingActions.askId, askId)
      )
    )

  sessionStore.queueSystemNote(
    sessionId,
    `<answer id="${askId}">${JSON.stringify(value)}</answer>`
  )
  return new Response(null, { status: 204 })
}
