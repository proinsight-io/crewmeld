/**
 * GET /api/employee/dev-studio/sessions/:sessionId/events
 *
 * BFF proxy for the opencode `/global/event` SSE stream.
 *
 * The browser cannot reach the in-cluster sandbox directly, so this route
 * resolves the sandbox endpoint via OpenSandboxClient and pipes the
 * `text/event-stream` body back transparently. The client is responsible for
 * filtering events by session (opencodeSessionId).
 *
 * Status codes:
 *  - 404  session not found
 *  - 409  session.coderType !== 'opencode' (claudecode has no SSE transport)
 *  - 502  no activeContainerId, endpoint unreachable, or upstream not ok
 */

import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { getCoderProvider } from '@/lib/dev-studio/coder-providers'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

const logger = createLogger('dev-studio:events')

// SSE must never be cached or statically optimized, and needs the Node runtime
// to pipe the upstream ReadableStream without buffering.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const { sessionId } = await params

  const session = await sessionStore.get(sessionId)
  if (!session) {
    return new Response('not found', { status: 404 })
  }
  if (session.coderType !== 'opencode') {
    return new Response('not an opencode session', { status: 409 })
  }
  if (!session.activeContainerId) {
    return new Response('no active container', { status: 502 })
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
    logger.warn('opencode SSE: sandbox endpoint unreachable', { sessionId, error: String(e) })
    return new Response('sandbox unreachable', { status: 502 })
  }

  const token = provider.authQuery(env)
  const upstreamUrl = `${baseUrl}/global/event${token ? `?auth_token=${encodeURIComponent(token)}` : ''}`

  // A freshly created sandbox reports its container "running" (and the endpoint
  // resolves) BEFORE the in-container `opencode serve` process is actually
  // listening. A single failed connect here returns 502, which the browser
  // EventSource treats as fatal (it will not natively reconnect). Retry briefly
  // to absorb that boot lag so the first connection succeeds rather than
  // bouncing the client into its own backoff/watchdog wait.
  const MAX_ATTEMPTS = 10
  const RETRY_DELAY_MS = 1000
  let upstream: Response | null = null
  let sawSandboxGone = false
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (req.signal.aborted) {
      return new Response('client aborted', { status: 499 })
    }
    try {
      const res = await fetch(upstreamUrl, {
        headers: { ...client.proxyHeaders() },
        signal: req.signal,
      })
      if (res.ok && res.body) {
        upstream = res
        break
      }
      // A 404 from the proxy means the sandbox itself is gone: `/global/event`
      // is not session-scoped, so a live opencode would answer 200/401. This is
      // terminal (a reaped/expired container), not the transient boot-lag the
      // retry loop absorbs — stop early and flag it for demotion below.
      if (res.status === 404) {
        sawSandboxGone = true
        break
      }
      logger.warn('opencode SSE: upstream not ok, will retry', {
        sessionId,
        status: res.status,
        attempt,
      })
    } catch (e) {
      // An abort means the client navigated away — stop, do not keep retrying.
      if (req.signal.aborted) {
        return new Response('client aborted', { status: 499 })
      }
      logger.warn('opencode SSE: upstream fetch failed, will retry', {
        sessionId,
        error: String(e),
        attempt,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }

  // Sandbox reported gone: confirm against the lifecycle API and, if it is truly
  // not running, demote the row so the UI surfaces the resume/rehydrate overlay
  // (the 60s session-list poll picks up containerStatus='destroyed') instead of
  // looping "connecting" against a dead container forever. On an inconclusive
  // check we default to leaving the row alone rather than wrongly destroying it.
  if (sawSandboxGone && session.activeContainerId) {
    const running = await client.isSandboxRunning(session.activeContainerId).catch(() => true)
    if (!running) {
      await sessionStore
        .update(sessionId, { containerStatus: 'destroyed', activeContainerId: null })
        .catch((e) =>
          logger.warn('failed to demote dead opencode session', { sessionId, error: String(e) })
        )
      return new Response('sandbox gone', { status: 410 })
    }
  }

  if (!upstream || !upstream.body) {
    logger.warn('opencode SSE upstream failed after retries', { sessionId })
    return new Response('upstream sse failed', { status: 502 })
  }

  // Pipe the SSE stream transparently; client filters by opencodeSessionId.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
