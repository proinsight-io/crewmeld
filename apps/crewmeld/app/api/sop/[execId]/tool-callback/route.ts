/**
 * POST /api/sop/[execId]/tool-callback
 *
 * Completion callback for an async SOP tool. The tool's platform wrapper (pod
 * python relay, api self-post, or http relay) POSTs its result here; we
 * authenticate via the per-call HMAC token, finalize the result onto the
 * matching pending work-log row, tear down the pod, and resume the SOP once the
 * node's whole round has completed.
 *
 * Body: `{ callId, token, status: 'completed'|'failed', result?, error? }`.
 * Auth is the token (bound to execId+callId) — no session; the callback comes
 * from inside a tool pod. Always returns 200 for an already-finalized call so a
 * retrying tool does not loop.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { verifyCallbackToken } from '@/lib/sop/async-tool-callback-token'
import { handleToolCallback } from '@/lib/sop/tool-callback-handler'

interface CallbackPayload {
  callId?: unknown
  token?: unknown
  status?: unknown
  result?: unknown
  error?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ execId: string }> }
): Promise<NextResponse> {
  const { execId } = await params
  const body = (await request.json().catch(() => null)) as CallbackPayload | null

  if (!body || typeof body.callId !== 'string' || typeof body.token !== 'string') {
    return NextResponse.json({ ok: false, error: 'Missing callId or token' }, { status: 400 })
  }
  if (!verifyCallbackToken(execId, body.callId, body.token)) {
    return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 401 })
  }

  const status = body.status === 'completed' ? 'completed' : 'failed'
  const outcome = await handleToolCallback(execId, {
    callId: body.callId,
    status,
    result: body.result,
    error: typeof body.error === 'string' ? body.error : undefined,
  })

  return NextResponse.json(outcome)
}
