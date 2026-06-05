/**
 * POST /api/employee/dev-studio/sessions/:sessionId/run-test
 *
 * SSE-streaming test execution via the fresh-sandbox orchestration pipeline.
 * Each orchestration phase emits an SSE frame so the UI can render real-time
 * progress. The stream terminates with a `done` event.
 *
 * A Redis distributed lock prevents concurrent executions on the same session.
 * The lock TTL (600s) is generous enough to cover the longest realistic run
 * (builder pip install + service start + invoke).
 *
 * Errors:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user (no info leak)
 *  - 409 — concurrent execution already in progress for this session
 *
 * SSE frame format: `event: <type>\ndata: <JSON>\n\n`
 */
import { db, toolExecutions } from '@crewmeld/db'
import { z } from 'zod'
import { generateExecutionId } from '@/lib/core/execution-id'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { acquireLock, releaseLock } from '@/lib/core/config/redis'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { runFreshTest, type LoaderEvent } from '@/lib/dev-studio/sandbox-loader'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** Request body schema for the SSE run-test endpoint. */
const RunTestBodySchema = z
  .object({
    input: z.record(z.unknown()),
    env: z.record(z.unknown()),
    extraEgress: z.array(z.string()).optional().default([]),
    connectionId: z.string().nullish(),
  })
  .strict()

/** Format a single SSE frame. */
function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/** Redis lock key scoped to a session. */
function lockKey(sessionId: string): string {
  return `dev-studio:run-test:lock:${sessionId}`
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  /* ── Auth guard ─────────────────────────────────────────────── */
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  /* ── Parse body ─────────────────────────────────────────────── */
  const raw = await req.json().catch(() => null)
  const parsed = RunTestBodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      { error: 'bad-request', detail: parsed.error.message, retryable: false },
      { status: 400 }
    )
  }
  const { input, env, extraEgress, connectionId } = parsed.data

  /* ── Redis lock ─────────────────────────────────────────────── */
  // Anchor the execId's embedded date to the session's createdAt — not
  // today — so all run-tests of a long-lived session share one sop-files
  // date dir (`sop-files/<sessionYear>/<sessionMonth>/<sessionDay>/<execId>/`).
  // Production SOPs use the SOP trigger date (default behavior) which
  // matches the user's mental model: "this run belongs to that activity's
  // start date".
  const executionId = generateExecutionId('test', session.createdAt)
  const lk = lockKey(sessionId)
  const acquired = await acquireLock(lk, executionId, 600)
  if (!acquired) {
    return Response.json(
      { error: 'concurrent-execution', detail: 'Another test run is already in progress.', retryable: true },
      { status: 409 }
    )
  }

  /* ── Persist tool_executions row ───────────────────────────── */
  // Persist BEFORE streaming starts so that the very first SSE `start`
  // event carries an executionId the client can already use against the
  // /api/employee/tool-execution/[execId]/files/* endpoints (spec §9.5).
  // If the insert fails we surface a clean 500 instead of starting a
  // half-broken stream.
  try {
    await db.insert(toolExecutions).values({
      id: executionId,
      userId: auth.userId,
      sessionId,
    })
  } catch (err) {
    await releaseLock(lk, executionId).catch(() => {})
    return Response.json(
      {
        error: 'execution-record-failed',
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
      { status: 500 }
    )
  }

  /* ── SSE stream ─────────────────────────────────────────────── */
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: LoaderEvent): void => {
        try {
          controller.enqueue(encoder.encode(sseFrame(event.type, JSON.stringify(event))))
        } catch {
          // Stream may already be closed by the client
        }
      }

      // Emit the executionId as the first frame so the UI can call into
      // /tool-execution/[executionId]/files/* even before sync completes.
      emit({ type: 'start', executionId })

      runFreshTest({ sessionId, executionId, input, env, extraEgress, connectionId, emit })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[run-test] runFreshTest failed:', message, err instanceof Error ? err.stack : '')
          const errorPhase = sseFrame('phase', JSON.stringify({
            type: 'phase',
            step: 'invoke',
            status: 'error',
            errorMessage: `Unexpected error: ${message}`,
          }))
          const doneEvt = sseFrame('done', JSON.stringify({
            type: 'done',
            executionId,
            sandboxId: '',
            kept: false,
          }))
          try {
            controller.enqueue(encoder.encode(errorPhase))
            controller.enqueue(encoder.encode(doneEvt))
          } catch {
            // Stream closed
          }
        })
        .finally(() => {
          releaseLock(lk, executionId).catch(() => {})
          try {
            controller.close()
          } catch {
            // Already closed
          }
        })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
