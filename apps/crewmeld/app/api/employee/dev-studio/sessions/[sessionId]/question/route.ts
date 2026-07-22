/**
 * POST /api/employee/dev-studio/sessions/:sessionId/question
 *
 * Relay a question reply or rejection from the operator back to the opencode
 * server running in the sandbox. opencode pauses and emits a `question.asked`
 * SSE event when the agent needs structured clarifying input; the client shows
 * a question-dock card and calls this endpoint so opencode can resume.
 *
 * Only valid for opencode sessions (`coderType === 'opencode'`).
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import {
  listOpencodeQuestions,
  rejectOpencodeQuestion,
  replyOpencodeQuestion,
} from '@/lib/dev-studio/opencode-rest'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('dev-studio:question')

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const Body = z.object({
  requestId: z.string().min(1),
  answers: z.array(z.array(z.string())).optional(),
  reject: z.boolean().optional(),
  // opencode workspace-routing hints. The question routes are not session-scoped,
  // so these pin the reply/reject to the Location the question was raised in
  // (empty/wrong Location → 404 on multi-workspace deployments). `workspace`
  // proxies to a remote workspace on k8s control-plane; `directory` suffices for
  // single-workspace/local.
  directory: z.string().optional(),
  workspace: z.string().optional(),
})

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId || session.coderType !== 'opencode') {
    return new Response('not found', { status: 404 })
  }
  if (!session.activeContainerId) {
    return new Response('no active container', { status: 502 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return new Response('bad request', { status: 400 })
  }

  const env = getDevStudioEnv()
  const provider = getCoderProvider('opencode')
  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  let baseUrl: string
  try {
    baseUrl = await client.getEndpoint(session.activeContainerId, provider.port)
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'sandbox-unreachable', detail: String(e), retryable: true }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  const headers: Record<string, string> = {
    ...(provider.authHeader(env) ?? {}),
    ...client.proxyHeaders(),
  }

  try {
    if (parsed.data.reject === true) {
      await rejectOpencodeQuestion(
        baseUrl,
        headers,
        parsed.data.requestId,
        parsed.data.directory,
        parsed.data.workspace
      )
    } else {
      await replyOpencodeQuestion(
        baseUrl,
        headers,
        parsed.data.requestId,
        parsed.data.answers ?? [],
        parsed.data.directory,
        parsed.data.workspace
      )
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'opencode-error', detail: String(e), retryable: false }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * GET /api/employee/dev-studio/sessions/:sessionId/question
 *
 * Poll-based resilience fallback: list pending question requests from the
 * opencode server so the question card can appear even when the `question.asked`
 * SSE event was buffered or dropped. Returns `{ questions: [] }` (200) on any
 * transient failure so the caller's poll loop is never error-spammed.
 *
 * Only valid for opencode sessions (`coderType === 'opencode'`).
 */
export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId || session.coderType !== 'opencode') {
    return new Response('not found', { status: 404 })
  }

  // No active container or no opencode session yet — not an error, just empty.
  if (!session.activeContainerId) {
    log.info('question poll empty: no active container', { sessionId })
    return new Response(JSON.stringify({ questions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (!session.opencodeSessionId) {
    log.info('question poll empty: no opencodeSessionId on session row', { sessionId })
    return new Response(JSON.stringify({ questions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const env = getDevStudioEnv()
  const provider = getCoderProvider('opencode')
  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  let baseUrl: string
  try {
    baseUrl = await client.getEndpoint(session.activeContainerId, provider.port)
  } catch (e) {
    // Poll must not error-spam the client — treat an unreachable sandbox as empty.
    log.info('question poll empty: sandbox endpoint unreachable', {
      sessionId,
      containerId: session.activeContainerId,
      detail: String(e),
    })
    return new Response(JSON.stringify({ questions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const headers: Record<string, string> = {
    ...(provider.authHeader(env) ?? {}),
    ...client.proxyHeaders(),
  }

  try {
    // Workspace-routing hint from the client poll (sourced from the SSE frame's
    // top-level `directory`); without it opencode routes the non-session-scoped
    // list to the wrong Location and returns empty on k8s control-plane.
    const sp = new URL(req.url).searchParams
    const directory = sp.get('directory') ?? undefined
    const workspace = sp.get('workspace') ?? undefined
    const all = await listOpencodeQuestions(baseUrl, headers, directory, workspace)
    const filtered = all.filter((q) => q.sessionID === session.opencodeSessionId)
    // Diagnostic: distinguishes "opencode has no pending questions" (all=0) from
    // "questions exist but the sessionID filter drops them" (all>0, filtered=0).
    log.info('question poll result', {
      sessionId,
      opencodeSessionId: session.opencodeSessionId,
      baseUrl,
      rawCount: all.length,
      filteredCount: filtered.length,
      rawSessionIDs: all.map((q) => q.sessionID),
    })
    return new Response(JSON.stringify({ questions: filtered }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (e) {
    // Any transient failure returns empty so the poll loop is never stuck. A 404
    // here means the opencode server in this image has no `/question` endpoint at
    // all (i.e. the whole question feature is unsupported by this build).
    log.warn('question poll empty: opencode /question call failed', {
      sessionId,
      baseUrl,
      detail: String(e),
    })
    return new Response(JSON.stringify({ questions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
