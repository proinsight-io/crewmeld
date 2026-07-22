/**
 * POST /api/employee/dev-studio/sessions/:sessionId/permission
 *
 * Task 10: relay a permission reply from the operator back to the opencode
 * server running in the sandbox. opencode pauses execution when a tool
 * requires approval and emits a permission request over SSE; the client
 * receives it, shows a dialog, and calls this endpoint with the operator's
 * decision so opencode can resume.
 *
 * Only valid for opencode sessions (`coderType === 'opencode'`).
 * claudecode handles permissions inline — it does not use this endpoint.
 */

import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { replyOpencodePermission } from '@/lib/dev-studio/opencode-rest'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const Body = z.object({
  requestId: z.string().min(1),
  reply: z.enum(['once', 'always', 'reject']),
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

  await replyOpencodePermission(baseUrl, headers, parsed.data.requestId, parsed.data.reply)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
